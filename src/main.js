const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { DataStore, scoreToTier } = require('./data');
const { AugmentMatcher } = require('./matcher');
const { createOcrWorker, recognize, upscaleFor, DEFAULT_REGION } = require('./ocr');

let mainWin = null;
let overlayWin = null;
let store = null;
let matcher = null;
let ocrWorker = null;

const state = {
  champion: null, // {key,id,name,icon}
  stats: {}, // augmentId -> {score,...}
  sources: {},
  running: false,
  busy: false,
  misses: 0,
  lastCards: '',
  timer: null,
  paused: false, // pausado pelo usuário
  inGame: false,
  gameMode: null,
  gameMisses: 0,
  gameTimer: null,
};

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

function buildCards(matches, { offsetX = 0, offsetY = 0, scale = 1 } = {}) {
  const ranked = matches
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
        // posição em pixels lógicos (DIP) da tela, para o overlay
        box: {
          x: (m.bbox.x0 + offsetX) / scale,
          y: (m.bbox.y0 + offsetY) / scale,
          w: (m.bbox.x1 - m.bbox.x0) / scale,
          h: (m.bbox.y1 - m.bbox.y0) / scale,
        },
      };
    });
  const order = [...ranked].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  order.forEach((c, i) => { c.rank = c.score == null ? null : i + 1; });
  return ranked;
}

async function scanOnce() {
  if (state.busy || !state.champion) return;
  state.busy = true;
  try {
    const cap = await captureRegion();
    if (settings.saveDebugCapture) {
      fs.writeFileSync(path.join(app.getPath('userData'), 'ultima-captura.png'), cap.img.toPNG());
    }
    const { lines } = await ocrImage(cap.img, cap.full.height);
    const matches = matcher.match(lines, { frameHeight: cap.full.height });
    if (matches.length >= 2) {
      state.misses = 0;
      const cards = buildCards(matches, { offsetX: cap.rect.x, offsetY: cap.rect.y, scale: cap.scale });
      const sig = cards.map((c) => c.id).join(',');
      showOverlay({ champion: state.champion, cards });
      if (sig !== state.lastCards) {
        state.lastCards = sig;
        send('cards', { champion: state.champion, cards, at: Date.now() });
        status(`Cartas detectadas: ${cards.map((c) => c.name).join(' · ')}`, 'ok');
      }
    } else if (++state.misses >= 1) {
      // A leitura é rápida (~0,4 s): uma leitura sem cartas já basta para esconder.
      state.lastCards = '';
      hideOverlay();
    }
  } catch (err) {
    status(`Erro na leitura: ${err.message}`, 'error');
  } finally {
    state.busy = false;
  }
}

function startScanning() {
  if (state.running) return;
  state.running = true;
  state.misses = 0;
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
  status(`Partida detectada: ${champ.name}. Baixando dados…`);
  const { stats, sources } = await store.championStats(champ);
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
      { host: '127.0.0.1', port: 2999, path: p, rejectUnauthorized: false, timeout: 1500 },
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
  const raw = (player.rawChampionName || '').replace('game_character_displayname_', '');
  return { champion: raw || player.championName, gameMode: (data.gameData && data.gameData.gameMode) || '' };
}

// Modos que certamente não têm as cartas do Mayhem: não gasta CPU lendo a tela neles.
const MODES_WITHOUT_MAYHEM_CARDS = new Set(['CLASSIC', 'CHERRY', 'TUTORIAL', 'PRACTICETOOL']);

async function gameTick() {
  try {
    const g = await detectGame();
    if (!g) return;
    state.gameMisses = 0;
    if (!state.inGame || state.gameMode !== g.gameMode) {
      state.inGame = true;
      state.gameMode = g.gameMode;
      sendGameState();
    }
    await loadChampion(g.champion);
    const scanMode = !MODES_WITHOUT_MAYHEM_CARDS.has(g.gameMode);
    if (scanMode && !state.paused && !state.running) startScanning();
    if (!scanMode && state.running) stopScanning();
    if (!scanMode) status(`Partida em modo ${g.gameMode}: não é ARAM Mayhem, a tela não será lida.`);
  } catch (_) {
    // Sem partida em andamento (ou o jogo ainda carregando).
    if (state.inGame && ++state.gameMisses >= 2) {
      state.inGame = false;
      state.gameMode = null;
      state.lastCards = '';
      stopScanning();
      status('Partida encerrada. Aguardando a próxima…');
    }
  }
}

function startGameWatcher() {
  clearInterval(state.gameTimer);
  state.gameTimer = setInterval(gameTick, 3000);
  gameTick();
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
    gameTick();
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
  const probe = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
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
  const cards = buildCards(matches, { offsetX: rect.x, offsetY: rect.y });
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
    startGameWatcher(); // usa a Live Client API de verdade (ou um servidor falso em testes)
    await wait(6000);
  } else if (process.env.MAYHEM_SNAPSHOT_GAME) {
    state.inGame = true;
    state.gameMode = 'KIWI';
    sendGameState();
    await loadChampion('Ahri');
  }
  await wait(2500);
  const cards = buildCards([
    { id: '1053', score: 0.97, bbox: { x0: 330, y0: 520, x1: 560, y1: 550 } },
    { id: '2132', score: 1, bbox: { x0: 840, y0: 520, x1: 1080, y1: 550 } },
    { id: '1097', score: 0.9, bbox: { x0: 1350, y0: 520, x1: 1590, y1: 550 } },
  ].filter((m) => store.augments[m.id]));
  send('cards', { champion: state.champion, cards });
  await wait(1500);
  fs.writeFileSync(path.join(outDir, 'main.png'), (await mainWin.webContents.capturePage()).toPNG());

  const ov = new BrowserWindow({ width: 1920, height: 1080, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), offscreen: true } });
  await ov.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  await ov.webContents.insertCSS('body{background:#3a3550 !important}');
  ov.webContents.send('cards', { champion: state.champion, cards });
  await wait(1200);
  fs.writeFileSync(path.join(outDir, 'overlay.png'), (await ov.webContents.capturePage()).toPNG());
  app.exit(0);
}

app.on('before-quit', async () => {
  state.running = false;
  if (ocrWorker) {
    try { await ocrWorker.terminate(); } catch (_) {}
  }
});
