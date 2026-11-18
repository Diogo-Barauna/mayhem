const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { DataStore, scoreToTier } = require('./data');
const { AugmentMatcher } = require('./matcher');
const { CardTracker } = require('./tracker');
const { GameWatcher, championCandidates } = require('./game-watcher');
const { createOcrWorker, recognize, upscaleFor, DEFAULT_REGION } = require('./ocr');

let mainWin = null;
let overlayWin = null;
let store = null;
let matcher = null;
let ocrWorker = null;
const tracker = new CardTracker();

const state = {
  champion: null, // {key,id,name,icon}
  stats: {}, // augmentId -> {score,...}
  sources: {},
  running: false,
  busy: false,
  lastCards: '',
  timer: null,
  paused: false, // pausado pelo usuário
  inGame: false,
  gameMode: null,
  gameTimer: null,
  session: 0, // incrementa a cada partida: cargas de dados de uma partida antiga são descartadas
};
let watcher = null;

// Testes podem isolar configurações, cache e log numa pasta própria.
if (process.env.MAYHEM_USERDATA) app.setPath('userData', process.env.MAYHEM_USERDATA);

// ---------------- log de diagnóstico ----------------
// %APPDATA%/Mayhem Augment Helper/app.log (o botão "Abrir pasta de dados" leva até ele).
function log(...parts) {
  try {
    const file = path.join(app.getPath('userData'), 'app.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old');
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}
`);
  } catch (_) { /* log nunca pode derrubar o app */ }
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const SETTINGS_VERSION = 2;
const defaultSettings = {
  settingsVersion: SETTINGS_VERSION,
  intervalMs: 150, // pausa entre leituras (cada leitura de OCR leva ~0,3-0,5 s)
  displayIndex: 0, // 0 = monitor principal
  // Faixa dos TÍTULOS das cartas (fração da tela). Medido num print 1920x1080: títulos em ~41% da altura.
  // Ler só essa faixa deixa o OCR ~4x mais rápido e evita falsos positivos nas descrições.
  region: { ...DEFAULT_REGION },
  ocrLang: 'por', // idioma do cliente do LoL: 'por', 'eng' ou 'por+eng' (mais lento)
  saveDebugCapture: false,
};
let settings = { ...defaultSettings };

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...defaultSettings, ...saved };
    if ((saved.settingsVersion || 1) < SETTINGS_VERSION) {
      // Versão 1 lia uma área enorme e com intervalo longo: troca pelos novos padrões.
      settings = { ...settings, region: defaultSettings.region, intervalMs: defaultSettings.intervalMs, settingsVersion: SETTINGS_VERSION };
    }
  } catch (_) { settings = { ...defaultSettings }; }
}
function saveSettings() {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}
function status(text, level = 'info') {
  send('status', { text, level, time: Date.now() });
}

// ---------------- janelas ----------------
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'Mayhem Augment Helper',
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('closed', () => {
    mainWin = null;
    app.quit();
  });
}

function targetDisplay() {
  const displays = screen.getAllDisplays();
  if (settings.displayIndex > 0 && displays[settings.displayIndex - 1]) return displays[settings.displayIndex - 1];
  return screen.getPrimaryDisplay();
}

function createOverlay() {
  const d = targetDisplay();
  overlayWin = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true); // cliques passam direto para o jogo
  overlayWin.setVisibleOnAllWorkspaces(true);
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
}

function repositionOverlay() {
  if (!overlayWin) return;
  const d = targetDisplay();
  overlayWin.setBounds(d.bounds);
}

function showOverlay(payload) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.webContents.send('cards', payload);
  if (!overlayWin.isVisible()) overlayWin.showInactive();
}
function hideOverlay() {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
    overlayWin.webContents.send('cards', null);
    overlayWin.hide();
  }
}

// ---------------- OCR ----------------
async function getOcr() {
  if (ocrWorker) return ocrWorker;
  status('Carregando OCR (na primeira vez baixa ~15 MB de dados de idioma)…');
  ocrWorker = await createOcrWorker(path.join(app.getPath('userData'), 'tessdata'), settings.ocrLang.split('+'));
  status('OCR pronto.');
  return ocrWorker;
}

async function ocrImage(img, frameHeight) {
  return recognize(await getOcr(), img, { scale: upscaleFor(frameHeight) });
}

// ---------------- captura ----------------
async function captureRegion() {
  const d = targetDisplay();
  const sf = d.scaleFactor || 1;
  const size = { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
  if (!src) throw new Error('Nenhuma tela disponível para captura.');
  const full = src.thumbnail;
  const fs_ = full.getSize();
  const r = settings.region;
  const rect = {
    x: Math.round(fs_.width * r.x),
    y: Math.round(fs_.height * r.y),
    width: Math.round(fs_.width * r.w),
    height: Math.round(fs_.height * r.h),
  };
  return { img: full.crop(rect), rect, full: fs_, scale: fs_.width / d.bounds.width };
}

// Converte matches de UMA leitura (bbox no recorte) em cartas no formato do tracker (centro no quadro).
function matchesToFrame(matches, offsetX = 0, offsetY = 0) {
  return matches.map((m) => ({
    ...m,
    bbox: { x0: m.bbox.x0 + offsetX, y0: m.bbox.y0 + offsetY, x1: m.bbox.x1 + offsetX, y1: m.bbox.y1 + offsetY },
    cx: (m.bbox.x0 + m.bbox.x1) / 2 + offsetX,
    cy: (m.bbox.y0 + m.bbox.y1) / 2 + offsetY,
  }));
}

// cards: [{id, cx, cy, score}] em pixels do quadro. O ranking é calculado sobre TODAS as cartas recebidas
// (as da sessão inteira, vindas do tracker), nunca só sobre as que a última leitura achou.
function buildCards(cards, { scale = 1 } = {}) {
  const ranked = cards
    .map((m) => {
      const aug = store.augments[m.id] || { name: `#${m.id}`, namePt: `#${m.id}` };
      const st = state.stats[m.id] || {};
      return {
        id: m.id,
        name: aug.namePt || aug.name,
        nameEn: aug.name,
        icon: aug.icon,
        score: st.score ?? null,
        tier: scoreToTier(st.score),
        blitzTier: st.blitzTier ?? null,
        opggPerf: st.opggPerf ?? null,
        opggPick: st.opggPick ?? null,
        ocrConfidence: Math.round(m.score * 100),
        // centro do título em pixels lógicos (DIP) da tela, para o overlay
        anchor: { x: m.cx / scale, y: m.cy / scale },
      };
    });
  const order = [...ranked].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  order.forEach((c, i) => { c.rank = c.score == null ? null : i + 1; });
  return ranked;
}

async function scanOnce() {
  if (state.busy || !state.champion) return;
  state.busy = true;
  const session = state.session;
  try {
    const cap = await captureRegion();
    if (settings.saveDebugCapture) {
      fs.writeFileSync(path.join(app.getPath('userData'), 'ultima-captura.png'), cap.img.toPNG());
    }
    const { lines } = await ocrImage(cap.img, cap.full.height);
    // A partida acabou (ou o scan foi pausado) enquanto o OCR rodava: descarta esta leitura.
    if (session !== state.session || !state.running) return;
    const matches = matcher.match(lines, { frameHeight: cap.full.height });
    // O tracker mantém as cartas entre leituras: uma leitura que perde uma carta não faz o selo piscar.
    const r = tracker.update(matchesToFrame(matches, cap.rect.x, cap.rect.y), cap.full);
    if (!r.changed) return;
    if (!r.visible) {
      state.lastCards = '';
      hideOverlay();
      return;
    }
    const cards = buildCards(r.cards, { scale: cap.scale });
    showOverlay({ champion: state.champion, cards, screenH: cap.full.height / cap.scale });
    const sig = cards.map((c) => c.id).join(',');
    if (sig !== state.lastCards) {
      state.lastCards = sig;
      send('cards', { champion: state.champion, cards, at: Date.now() });
      status(`Cartas detectadas: ${cards.map((c) => c.name).join(' · ')}`, 'ok');
    }
  } catch (err) {
    status(`Erro na leitura: ${err.message}`, 'error');
    log('erro na leitura:', err.message);
  } finally {
    state.busy = false;
  }
}

function startScanning() {
  if (state.running) return;
  if (process.env.MAYHEM_SNAPSHOT) return; // modo de teste: nunca captura a tela do usuário
  state.running = true;
  tracker.reset();
  getOcr().catch((e) => status(`Falha ao iniciar OCR: ${e.message}`, 'error'));
  const loop = async () => {
    if (!state.running) return;
    await scanOnce();
    state.timer = setTimeout(loop, settings.intervalMs);
  };
  loop();
  sendGameState();
}

function stopScanning() {
  state.running = false;
  clearTimeout(state.timer);
  tracker.reset();
  state.lastCards = '';
  hideOverlay();
  sendGameState();
}

function sendGameState() {
  send('game', { inGame: state.inGame, gameMode: state.gameMode, running: state.running, paused: state.paused });
}

// ---------------- campeão (detectado na partida) ----------------
async function loadChampion(query) {
  const champ = store.findChampion(query);
  if (!champ) throw new Error(`Campeão não reconhecido: ${query}`);
  if (state.champion && state.champion.key === champ.key && Object.keys(state.stats).length) return publicChampState();
  const session = state.session;
  status(`Partida detectada: ${champ.name}. Baixando dados…`);
  const t0 = Date.now();
  const { stats, sources } = await store.championStats(champ);
  if (session !== state.session) {
    // A partida mudou enquanto os dados baixavam: descarta.
    log('carga descartada (partida mudou):', champ.name);
    return null;
  }
  log('campeão carregado:', champ.name, { blitz: sources.blitz, opgg: sources.opgg, augments: Object.keys(stats).length, ms: Date.now() - t0 });
  state.champion = champ;
  state.stats = stats;
  state.sources = sources;
  matcher.setAugments(store.augments); // op.gg pode ter adicionado augments novos
  const src = [sources.blitz && 'Blitz', sources.opgg && 'op.gg'].filter(Boolean).join(' + ') || 'nenhuma fonte';
  const pub = publicChampState();
  status(`${champ.name}: ${pub.augments.length} augments com dados (${src}). Monitorando as cartas…`, 'ok');
  send('champion', pub);
  return pub;
}

function publicChampState() {
  if (!state.champion) return null;
  const list = Object.entries(state.stats)
    .filter(([id, s]) => s.score != null && store.augments[id])
    .map(([id, s]) => ({
      id,
      name: store.augments[id].namePt,
      nameEn: store.augments[id].name,
      icon: store.augments[id].icon,
      rarity: store.augments[id].rarity,
      score: s.score,
      tier: scoreToTier(s.score),
      blitzTier: s.blitzTier,
      opggPerf: s.opggPerf,
      opggPick: s.opggPick,
    }))
    .sort((a, b) => b.score - a.score);
  return { champion: state.champion, sources: state.sources, patch: store.patch, augments: list };
}

// Live Client Data API (local, oficial da Riot; só responde com uma partida em andamento).
function liveClientGet(p) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      // Porta oficial 2999; MAYHEM_LIVE_PORT só para testes com servidor falso.
      { host: '127.0.0.1', port: Number(process.env.MAYHEM_LIVE_PORT) || 2999, path: p, rejectUnauthorized: false, timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function detectGame() {
  const data = await liveClientGet('/liveclientdata/allgamedata');
  const me = data.activePlayer || {};
  const myId = me.riotId || me.summonerName;
  const players = data.allPlayers || [];
  const player = players.find((p) => (p.riotId || p.summonerName) === myId);
  if (!player) return null; // tela de carregamento: dados ainda incompletos
  const candidates = championCandidates(player);
  // Usa o primeiro candidato que corresponde a um campeão conhecido (ID do Data Dragon).
  const known = candidates.map((c) => store.findChampion(c)).find(Boolean);
  const gd = data.gameData || {};
  return {
    champion: known ? known.id : candidates[0] || '?',
    candidates,
    gameMode: gd.gameMode || '',
    gameTime: typeof gd.gameTime === 'number' ? gd.gameTime : null,
  };
}

// Modos que certamente não têm as cartas do Mayhem: não gasta CPU lendo a tela neles.
const MODES_WITHOUT_MAYHEM_CARDS = new Set(['CLASSIC', 'CHERRY', 'TUTORIAL', 'PRACTICETOOL']);

// Limpa TUDO da partida anterior: campeão, estatísticas, cartas, overlay e a janela principal.
function resetSession() {
  state.session++;
  stopScanning();
  state.champion = null;
  state.stats = {};
  state.sources = {};
  state.lastCards = '';
  state.inGame = false;
  state.gameMode = null;
  send('champion', null);
  send('cards', null);
  sendGameState();
}

const isScanMode = (mode) => !MODES_WITHOUT_MAYHEM_CARDS.has(mode);

function maybeStartScanning() {
  if (state.inGame && isScanMode(state.gameMode) && !state.paused && !state.running) startScanning();
}

function onGameStart(game) {
  resetSession();
  log('partida detectada:', game);
  state.inGame = true;
  state.gameMode = game.gameMode;
  sendGameState();
  if (isScanMode(game.gameMode)) {
    // Começa a ler já (o OCR aquece enquanto os dados baixam); scanOnce só mostra selos com o campeão carregado.
    maybeStartScanning();
  } else {
    status(`Partida em modo ${game.gameMode}: não é ARAM Mayhem, a tela não será lida.`);
  }
  // Não bloqueia o watcher: se o download demorar, o fim/início das próximas partidas continua sendo detectado.
  loadChampion(game.champion).catch((err) => {
    log('erro ao carregar campeão:', game.champion, err.message);
    status(`Erro ao carregar ${game.champion}: ${err.message}`, 'error');
  });
}

function onGameEnd(game) {
  log('partida encerrada:', game);
  resetSession();
  status('Partida encerrada. Aguardando a próxima…');
}

function startGameWatcher() {
  clearTimeout(state.gameTimer);
  watcher = new GameWatcher({
    detect: detectGame,
    onGameStart,
    onGameEnd,
    onError: (err) => log('erro no ciclo de partidas:', err.message),
  });
  // setTimeout encadeado: o próximo tick só é agendado quando o anterior termina.
  const loop = async () => {
    try { await watcher.tick(); } catch (err) { log('erro no tick:', err.message); }
    state.gameTimer = setTimeout(loop, 3000);
  };
  loop();
}

// ---------------- IPC ----------------
ipcMain.handle('init', async () => {
  const info = await store.init();
  matcher = new AugmentMatcher(store.augments);
  if (!process.env.MAYHEM_SNAPSHOT) startGameWatcher();
  return {
    ...info,
    settings,
    displays: screen.getAllDisplays().map((d, i) => ({ index: i + 1, label: `${d.size.width}x${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ' (principal)' : ''}` })),
    champion: publicChampState(),
    game: { inGame: state.inGame, gameMode: state.gameMode, running: state.running, paused: state.paused },
  };
});
ipcMain.handle('toggle-pause', () => {
  state.paused = !state.paused;
  if (state.paused) {
    stopScanning();
    status('Pausado. A tela não será lida até você retomar.');
  } else {
    sendGameState();
    status(state.inGame ? 'Retomado.' : 'Retomado. Aguardando uma partida…');
    maybeStartScanning();
  }
  return state.paused;
});
ipcMain.handle('save-settings', async (_e, s) => {
  const langChanged = s.ocrLang && s.ocrLang !== settings.ocrLang;
  settings = { ...settings, ...s };
  if (langChanged && ocrWorker) {
    const old = ocrWorker;
    ocrWorker = null; // recria com o novo idioma na próxima leitura
    old.terminate().catch(() => {});
  }
  saveSettings();
  repositionOverlay();
  return settings;
});
ipcMain.handle('refresh-data', async () => {
  for (const f of fs.readdirSync(store.cacheDir)) fs.rmSync(path.join(store.cacheDir, f), { force: true });
  await store.init();
  matcher.setAugments(store.augments);
  const champ = state.champion;
  state.champion = null;
  return champ ? loadChampion(champ.id) : null;
});
// nativeImage não decodifica webp no Windows: nesse caso renderiza a imagem numa janela fora da tela.
async function loadImageFile(file) {
  const img = nativeImage.createFromPath(file);
  if (!img.isEmpty()) return img;
  const b64 = fs.readFileSync(file).toString('base64');
  const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
  // enableLargerThanScreen: sem isso a janela é limitada à área de trabalho e um print 1080p sai cortado.
  const probe = new BrowserWindow({ show: false, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } });
  await probe.loadURL(`data:text/html,<body style="margin:0"><img id="i" src="data:image/${ext};base64,${b64}"></body>`);
  const { w, h } = await probe.webContents.executeJavaScript("new Promise(r=>{const i=document.getElementById('i');const f=()=>r({w:i.naturalWidth,h:i.naturalHeight});i.complete?f():i.onload=f})");
  probe.setContentSize(w, h);
  await new Promise((r) => setTimeout(r, 400));
  const shot = await probe.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  probe.destroy();
  return shot;
}

ipcMain.handle('test-image', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'Escolha um print da tela de seleção de cartas',
    filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const full = await loadImageFile(r.filePaths[0]);
  const fs_ = full.getSize();
  const reg = settings.region;
  const rect = { x: Math.round(fs_.width * reg.x), y: Math.round(fs_.height * reg.y), width: Math.round(fs_.width * reg.w), height: Math.round(fs_.height * reg.h) };
  status('Lendo imagem de teste…');
  const { lines, text } = await ocrImage(full.crop(rect), fs_.height);
  const matches = matcher.match(lines, { frameHeight: fs_.height });
  const cards = buildCards(matchesToFrame(matches, rect.x, rect.y));
  const noChamp = state.champion ? '' : ' (sem partida em andamento: mostrando só os nomes, sem ranking)';
  status(matches.length ? `Teste: ${matches.length} carta(s) reconhecida(s)${noChamp}.` : 'Teste: nenhuma carta reconhecida. Veja o texto lido pelo OCR.', matches.length ? 'ok' : 'error');
  return { cards, ocrText: text };
});
ipcMain.handle('open-data-folder', () => require('electron').shell.openPath(app.getPath('userData')));

// ---------------- ciclo de vida ----------------
app.whenReady().then(() => {
  loadSettings();
  store = new DataStore(path.join(app.getPath('userData'), 'cache'));
  if (process.env.MAYHEM_SNAPSHOT) return snapshotMode(process.env.MAYHEM_SNAPSHOT);
  createMainWindow();
  createOverlay();
});

// Modo de desenvolvimento: renderiza as janelas fora da tela com dados de exemplo e salva prints
// (não captura a tela do usuário). Uso: MAYHEM_SNAPSHOT=<pasta> npx electron .
async function snapshotMode(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  mainWin = new BrowserWindow({ width: 980, height: 720, show: false, backgroundColor: '#0f1117', webPreferences: { preload: path.join(__dirname, 'preload.js'), offscreen: true } });
  await mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await wait(2500);
  if (process.env.MAYHEM_SNAPSHOT_LIVE) {
    // Usa a Live Client API de verdade (ou um servidor falso em testes) por N segundos,
    // salvando um print da janela a cada 3 s para acompanhar o ciclo de partidas.
    startGameWatcher();
    const total = Number(process.env.MAYHEM_SNAPSHOT_LIVE) > 1 ? Number(process.env.MAYHEM_SNAPSHOT_LIVE) : 6;
    for (let t = 3; t <= total; t += 3) {
      await wait(3000);
      fs.writeFileSync(path.join(outDir, `live-${String(t).padStart(2, '0')}s.png`), (await mainWin.webContents.capturePage()).toPNG());
    }
  } else if (process.env.MAYHEM_SNAPSHOT_GAME) {
    state.inGame = true;
    state.gameMode = 'KIWI';
    sendGameState();
    await loadChampion(process.env.MAYHEM_SNAPSHOT_GAME === '1' ? 'Ahri' : process.env.MAYHEM_SNAPSHOT_GAME);
  }
  await wait(2500);
  // Com MAYHEM_SNAPSHOT_OCR=<print>: roda o pipeline real (OCR -> matcher -> tracker) no print e desenha o
  // overlay POR CIMA dele. Sem o print, usa cartas de exemplo nas posições medidas num print 1920x1080.
  let cards;
  let background = null;
  const ocrFile = process.env.MAYHEM_SNAPSHOT_OCR;
  if (ocrFile) {
    const result = { ok: false };
    try {
      const full = await loadImageFile(ocrFile);
      const size = full.getSize();
      const reg = settings.region;
      const rect = { x: Math.round(size.width * reg.x), y: Math.round(size.height * reg.y), width: Math.round(size.width * reg.w), height: Math.round(size.height * reg.h) };
      const t = Date.now();
      const { lines } = await ocrImage(full.crop(rect), size.height);
      result.ms = Date.now() - t;
      const matches = matcher.match(lines, { frameHeight: size.height });
      result.size = size;
      result.cards = matches.map((m) => store.augments[m.id].namePt);
      const tr = new CardTracker();
      const r = tr.update(matchesToFrame(matches, rect.x, rect.y), size);
      cards = buildCards(r.cards);
      result.overlay = cards.map((c) => ({ name: c.name, tier: c.tier, rank: c.rank, x: Math.round(c.anchor.x), y: Math.round(c.anchor.y) }));
      result.ok = true;
      background = full.toDataURL();
    } catch (e) {
      result.error = e.stack;
    }
    fs.writeFileSync(path.join(outDir, 'ocr.json'), JSON.stringify(result, null, 2));
  }
  if (!cards) {
    cards = buildCards([
      { id: '1053', score: 0.97, cx: 591, cy: 444 },
      { id: '2132', score: 1, cx: 959, cy: 444 },
      { id: '1097', score: 0.9, cx: 1327, cy: 444 },
    ].filter((m) => store.augments[m.id]));
  }
  send('cards', { champion: state.champion, cards });
  await wait(1500);
  fs.writeFileSync(path.join(outDir, 'main.png'), (await mainWin.webContents.capturePage()).toPNG());

  const ov = new BrowserWindow({ width: 1920, height: 1080, show: false, useContentSize: true, enableLargerThanScreen: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), offscreen: true } });
  await ov.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  await ov.webContents.insertCSS(background
    ? `body{background:url("${background}") 0 0 / 1920px 1080px no-repeat !important}`
    : 'body{background:#3a3550 !important}');
  ov.webContents.send('cards', { champion: state.champion || { name: '(sem partida)' }, cards, screenH: 1080 });
  await wait(1200);
  fs.writeFileSync(path.join(outDir, 'overlay.png'), (await ov.webContents.capturePage()).toPNG());

  if (ocrWorker) await ocrWorker.terminate().catch(() => {});
  app.exit(0);
}

app.on('before-quit', async () => {
  state.running = false;
  if (ocrWorker) {
    try { await ocrWorker.terminate(); } catch (_) {}
  }
});
