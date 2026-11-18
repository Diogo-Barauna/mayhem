const root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.api.on('cards', (p) => {
  root.innerHTML = '';
  if (!p || !p.cards || !p.cards.length) return;
  const best = p.cards.find((c) => c.rank === 1);
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `${esc(p.champion.name)} — melhor escolha: <b>${esc(best ? best.name : '?')}</b>`;
  root.appendChild(panel);
  for (const c of p.cards) {
    const el = document.createElement('div');
    el.className = 'badge' + (c.rank === 1 ? ' best' : '');
    el.style.left = `${c.box.x + c.box.w / 2}px`;
    el.style.top = `${Math.max(48, c.box.y - 10)}px`;
    const tierCls = c.tier === '?' ? 'q' : c.tier;
    const label = c.rank === 1 ? '★ MELHOR' : c.rank ? `#${c.rank}` : 'sem dados';
    el.innerHTML = `<div class="tier ${tierCls}">${esc(c.tier)}</div>
      <div><div class="label">${label}</div>
      <div class="sub">${c.score != null ? 'score ' + c.score.toFixed(0) : ''}${c.blitzTier ? ' · Blitz T' + c.blitzTier : ''}</div></div>`;
    root.appendChild(el);
  }
});
