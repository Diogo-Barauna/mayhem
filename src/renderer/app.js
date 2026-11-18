const $ = (id) => document.getElementById(id);
let current = null; // estado do campeão vindo do main
let settings = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function setStatus({ text, level }) {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${level || ''}`;
}

function tierBadge(t) {
  return `<span class="tier ${esc(t)}">${esc(t)}</span>`;
}

function nums(a) {
  const parts = [];
  if (a.score != null) parts.push(`score ${a.score.toFixed(1)}`);
  if (a.blitzTier) parts.push(`Blitz T${a.blitzTier}`);
  if (a.opggPerf != null) parts.push(`op.gg ${a.opggPerf.toFixed(1)} · pick ${a.opggPick}%`);
  return parts.join(' · ');
}

function renderChampion() {
  const box = $('champ');
  const hasChamp = !!current;
  document.querySelector('.list-head').classList.toggle('hidden', !hasChamp);
  $('augList').classList.toggle('hidden', !hasChamp);
  if (!hasChamp) return;
  const c = current.champion;
  const src = [current.sources.blitz && 'Blitz.gg', current.sources.opgg && 'op.gg'].filter(Boolean).join(' + ');
  box.className = 'champ';
  box.innerHTML = `<img src="${esc(c.icon)}" alt="" />
    <div><div class="name">${esc(c.name)}</div>
    <small>Detectado na partida · Patch ${esc(current.patch)} · ${current.augments.length} augments com dados · fonte: ${esc(src || 'nenhuma')}</small></div>`;
  renderList();
}

function renderList() {
  const ol = $('augList');
  ol.innerHTML = '';
  if (!current) return;
  const q = norm($('filter').value.trim());
  current.augments.forEach((a, i) => {
    if (q && !norm(a.name).includes(q) && !norm(a.nameEn).includes(q)) return;
    const li = document.createElement('li');
    li.innerHTML = `<span class="pos">${i + 1}</span>
      ${a.icon ? `<img loading="lazy" src="${esc(a.icon)}" alt="" />` : '<span></span>'}
      <div><div>${esc(a.name)}</div>${a.nameEn !== a.name ? `<div class="en">${esc(a.nameEn)}</div>` : ''}</div>
      <div style="display:flex;gap:10px;align-items:center"><span class="nums">${esc(nums(a))}</span>${tierBadge(a.tier)}</div>`;
    ol.appendChild(li);
  });
}

function renderCards(container, cards) {
  container.innerHTML = '';
  if (!cards.length) {
    container.innerHTML = '<small>Nenhuma carta reconhecida.</small>';
    return;
  }
  for (const c of cards) {
    const d = document.createElement('div');
    d.className = 'card' + (c.rank === 1 ? ' best' : '');
    d.innerHTML = `${tierBadge(c.tier)}
      ${c.icon ? `<img src="${esc(c.icon)}" alt="" />` : ''}
      <div><div class="cname">${c.rank === 1 ? '★ ' : ''}${esc(c.name)}</div>
      <div class="sub">${[c.rank ? `#${c.rank} de ${cards.length}` : 'sem dados', nums(c)].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="sub">OCR ${c.ocrConfidence}%</div></div>`;
    container.appendChild(d);
  }
}

function setGame(g) {
  const b = $('gameBadge');
  let cls = 'wait';
  let txt = 'Aguardando partida';
  if (g.paused) { cls = 'paused'; txt = 'Pausado'; }
  else if (g.inGame && g.running) { cls = 'live'; txt = 'Lendo a tela'; }
  else if (g.inGame) { cls = 'idle'; txt = `Em partida (${g.gameMode || '?'})`; }
  b.className = `gbadge ${cls}`;
  b.textContent = txt;
  $('btnPause').textContent = g.paused ? '▶ Retomar' : '⏸ Pausar';
}

// ---------- configurações ----------
function openSettings(displays) {
  $('setInterval').value = settings.intervalMs;
  $('setLang').value = settings.ocrLang;
  $('regX').value = Math.round(settings.region.x * 100);
  $('regY').value = Math.round(settings.region.y * 100);
  $('regW').value = Math.round(settings.region.w * 100);
  $('regH').value = Math.round(settings.region.h * 100);
  $('setDebug').checked = settings.saveDebugCapture;
  const sel = $('setDisplay');
  sel.innerHTML = '<option value="0">Monitor principal</option>' +
    displays.map((d) => `<option value="${d.index}">Monitor ${d.index}: ${esc(d.label)}</option>`).join('');
  sel.value = String(settings.displayIndex);
  $('settingsDlg').showModal();
}

async function saveSettingsFromForm() {
  const pct = (id, def) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) / 100 : def;
  };
  settings = await window.api.saveSettings({
    intervalMs: Math.max(0, Number($('setInterval').value) || 0),
    ocrLang: $('setLang').value,
    displayIndex: Number($('setDisplay').value) || 0,
    region: { x: pct('regX', 0.1), y: pct('regY', 0.37), w: pct('regW', 0.8), h: pct('regH', 0.1) },
    saveDebugCapture: $('setDebug').checked,
  });
  setStatus({ text: 'Configurações salvas.', level: 'ok' });
}

// Ícones que falharem (CSP não permite onerror inline): esconde.
document.addEventListener('error', (e) => {
  if (e.target && e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
}, true);

// ---------- boot ----------
(async function boot() {
  window.api.on('status', setStatus);
  window.api.on('game', setGame);
  window.api.on('champion', (c) => { current = c; renderChampion(); });
  window.api.on('cards', ({ cards }) => {
    $('lastCards').classList.remove('hidden');
    renderCards($('lastCardsList'), cards);
  });

  $('filter').addEventListener('input', renderList);

  try {
    const info = await window.api.init();
    settings = info.settings;
    $('meta').textContent = `Patch ${info.patch} · ${info.augments} augments · ${info.champions} campeões`;
    $('btnPause').disabled = false;
    $('btnPause').onclick = () => window.api.togglePause();
    $('btnSettings').onclick = () => openSettings(info.displays);
    $('btnSave').onclick = (e) => { e.preventDefault(); saveSettingsFromForm(); $('settingsDlg').close(); };
    $('btnFolder').onclick = () => window.api.openDataFolder();
    $('btnRefresh').onclick = async () => {
      setStatus({ text: 'Atualizando dados…' });
      try {
        const c = await window.api.refreshData();
        if (c) { current = c; renderChampion(); }
        setStatus({ text: 'Dados atualizados.', level: 'ok' });
      } catch (e) { setStatus({ text: e.message, level: 'error' }); }
    };
    $('btnTest').onclick = async () => {
      try {
        const r = await window.api.testImage();
        if (!r) return;
        renderCards($('testCards'), r.cards);
        $('testText').textContent = r.ocrText || '(vazio)';
        $('testDlg').showModal();
      } catch (e) { setStatus({ text: e.message, level: 'error' }); }
    };
    current = info.champion;
    setGame(info.game);
    renderChampion();
    if (!info.game.inGame) setStatus({ text: 'Pronto. Aguardando uma partida — pode minimizar o app.', level: 'ok' });
  } catch (e) {
    setStatus({ text: `Falha ao carregar dados: ${e.message}`, level: 'error' });
  }
})();
