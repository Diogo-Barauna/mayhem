// Overlay sobre o jogo. Os selos ficam ACIMA das cartas (perto da borda de cima), fora da faixa dos títulos
// que o OCR lê: assim o próprio overlay não interfere na leitura seguinte.
const root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Distância entre o centro do título e a borda de cima da carta, em fração da altura da tela
// (medido em 1080p: título em ~444 px, borda da carta em ~195 px).
const ABOVE_TITLE = 0.235;

const panel = document.createElement('div');
panel.className = 'panel';
panel.style.display = 'none';
root.appendChild(panel);
const badges = []; // elementos reaproveitados, um por carta
let lastSig = '';

function badgeEl(i) {
  if (!badges[i]) {
    const el = document.createElement('div');
    el.className = 'badge';
    el.innerHTML = '<div class="tier"></div><div><div class="label"></div><div class="sub"></div></div>';
    root.appendChild(el);
    badges[i] = el;
  }
  return badges[i];
}

window.api.on('cards', (p) => {
  const cards = (p && p.cards) || [];
  const sig = JSON.stringify(cards.map((c) => [c.id, c.rank, c.tier, Math.round(c.anchor.x), Math.round(c.anchor.y)]));
  if (sig === lastSig) return; // nada visível mudou: não mexe no DOM
  lastSig = sig;

  if (!cards.length) {
    panel.style.display = 'none';
    badges.forEach((b) => { b.style.display = 'none'; });
    return;
  }
  const screenH = p.screenH || window.innerHeight;
  const best = cards.find((c) => c.rank === 1);
  panel.innerHTML = `${esc(p.champion.name)} — melhor escolha: <b>${esc(best ? best.name : '?')}</b>`;
  panel.style.display = '';

  cards.forEach((c, i) => {
    const el = badgeEl(i);
    el.className = 'badge' + (c.rank === 1 ? ' best' : '');
    el.style.display = '';
    el.style.left = `${c.anchor.x}px`;
    el.style.top = `${Math.max(56, c.anchor.y - screenH * ABOVE_TITLE)}px`;
    const tier = el.querySelector('.tier');
    tier.className = `tier ${c.tier === '?' ? 'q' : c.tier}`;
    tier.textContent = c.tier;
    el.querySelector('.label').textContent = c.rank === 1 ? '★ MELHOR' : c.rank ? `#${c.rank}` : 'sem dados';
    el.querySelector('.sub').textContent =
      `${c.score != null ? 'score ' + c.score.toFixed(0) : ''}${c.blitzTier ? ' · Blitz T' + c.blitzTier : ''}`;
  });
  for (let i = cards.length; i < badges.length; i++) badges[i].style.display = 'none';
});
