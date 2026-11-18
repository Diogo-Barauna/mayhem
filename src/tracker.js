// Mantém o estado das cartas entre leituras, para o overlay não piscar.
//
// Cada leitura do OCR pode perder uma carta (animação, brilhos, reroll). Em vez de mostrar só o que a leitura
// atual achou, as cartas ficam em "slots" por posição:
//  - um slot mantém a carta quando ela não é lida;
//  - trocar a carta de um slot (reroll) exige 2 leituras seguidas com o mesmo ID novo;
//  - a posição do slot vem só de matches com o nome completo (o fallback de uma palavra não a move);
//  - a sessão abre com >=2 cartas numa leitura (ou 1 carta em 2 leituras seguidas) e fecha após
//    `closeAfterEmpty` (2) leituras seguidas sem nenhuma carta.
// Coordenadas: pixels do quadro inteiro (bbox já somado ao deslocamento do recorte).

class CardTracker {
  constructor({ closeAfterEmpty = 2, slotTolerance = 0.08, switchAfter = 2, maxSlots = 3 } = {}) {
    this.opts = { closeAfterEmpty, slotTolerance, switchAfter, maxSlots };
    this.reset();
  }

  reset() {
    this.active = false;
    this.slots = []; // {id, cx, cy, samples, score, pending: {id, count} | null}
    this.emptyStreak = 0;
    this.single = null; // {id, count}: 1 carta lida antes da sessão abrir
    this.lastSig = '';
  }

  // matches: [{id, score, bbox:{x0,y0,x1,y1}, partial?}], frame: {width, height}
  update(matches, frame) {
    const list = matches || [];
    if (!list.length) {
      this.emptyStreak++;
      if (this.active && this.emptyStreak >= this.opts.closeAfterEmpty) {
        this.reset();
        return this._result(true);
      }
      return this._result(false);
    }
    this.emptyStreak = 0;

    if (!this.active) {
      if (list.length === 1) {
        const id = list[0].id;
        this.single = this.single && this.single.id === id ? { id, count: this.single.count + 1 } : { id, count: 1 };
        if (this.single.count < 2) return this._result(false);
      }
      this.active = true;
      this.single = null;
    }

    const tol = frame.width * this.opts.slotTolerance;
    const touched = new Set();
    // Matches de nome completo primeiro: eles definem as posições.
    const ordered = [...list].sort((a, b) => Number(!!a.partial) - Number(!!b.partial));
    for (const m of ordered) {
      const cx = (m.bbox.x0 + m.bbox.x1) / 2;
      const cy = (m.bbox.y0 + m.bbox.y1) / 2;
      let slot = null;
      let best = Infinity;
      for (const s of this.slots) {
        const d = Math.abs(s.cx - cx);
        if (d <= tol && d < best) { best = d; slot = s; }
      }
      if (!slot) {
        // A mesma carta não pode estar em dois slots.
        if (this.slots.some((s) => s.id === m.id) || this.slots.length >= this.opts.maxSlots) continue;
        slot = { id: m.id, cx, cy, samples: m.partial ? 0 : 1, score: m.score, pending: null };
        this.slots.push(slot);
        touched.add(slot);
        continue;
      }
      if (touched.has(slot)) continue;
      touched.add(slot);

      if (slot.id === m.id) {
        slot.pending = null;
        slot.score = Math.max(slot.score, m.score);
        if (!m.partial) {
          if (slot.samples === 0) {
            slot.cx = cx;
            slot.cy = cy;
            slot.samples = 1;
          } else {
            const n = Math.min(slot.samples, 9);
            slot.cx = (slot.cx * n + cx) / (n + 1);
            slot.cy = (slot.cy * n + cy) / (n + 1);
            slot.samples++;
          }
        }
        continue;
      }
      // ID diferente no slot: possível reroll (ou erro de OCR). Confirma antes de trocar.
      if (this.slots.some((s) => s !== slot && s.id === m.id)) continue;
      slot.pending = slot.pending && slot.pending.id === m.id ? { id: m.id, count: slot.pending.count + 1 } : { id: m.id, count: 1 };
      if (slot.pending.count >= this.opts.switchAfter) {
        slot.id = m.id;
        slot.score = m.score;
        slot.pending = null;
        if (!m.partial) {
          slot.cx = cx;
          slot.cy = cy;
          slot.samples = 1;
        }
      }
    }
    // Um "reroll" pendente só vale para leituras seguidas.
    for (const s of this.slots) if (!touched.has(s)) s.pending = null;

    return this._result(false);
  }

  _result(forceChanged) {
    const cards = this.active
      ? [...this.slots].sort((a, b) => a.cx - b.cx).map((s) => ({ id: s.id, cx: s.cx, cy: s.cy, score: s.score }))
      : [];
    const sig = cards.map((c) => `${c.id}@${Math.round(c.cx / 8)},${Math.round(c.cy / 8)}`).join('|');
    const changed = forceChanged || sig !== this.lastSig;
    this.lastSig = sig;
    return { visible: this.active && cards.length > 0, cards, changed };
  }
}

module.exports = { CardTracker };
