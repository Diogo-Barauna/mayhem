// Testes do CardTracker (estabilidade do overlay entre leituras).
const assert = require('assert');
const { CardTracker } = require('../src/tracker');

module.exports = (t) => {
  const FRAME = { width: 1920, height: 1080 };
  const card = (id, cx, extra = {}) => ({ id, score: 1, bbox: { x0: cx - 100, y0: 433, x1: cx + 100, y1: 456 }, ...extra });
  const A = card('A', 591);
  const B = card('B', 959);
  const C = card('C', 1327);
  const ids = (r) => r.cards.map((c) => c.id).join(',');

  t('tracker: leituras 3/2/3/1 mantêm as 3 cartas nas mesmas posições', () => {
    const tr = new CardTracker();
    let first = null;
    for (const s of [[A, B, C], [A, C], [A, B, C], [C], [B, C], [A, B, C]]) {
      const r = tr.update(s, FRAME);
      assert.strictEqual(r.visible, true);
      assert.strictEqual(ids(r), 'A,B,C');
      const pos = r.cards.map((c) => Math.round(c.cx)).join(',');
      if (!first) first = pos;
      assert.strictEqual(pos, first);
    }
  });

  t('tracker: só sinaliza mudança quando algo visível muda', () => {
    const tr = new CardTracker();
    assert.strictEqual(tr.update([A, B, C], FRAME).changed, true);
    assert.strictEqual(tr.update([A, C], FRAME).changed, false);
    assert.strictEqual(tr.update([A, B, C], FRAME).changed, false);
  });

  t('tracker: reroll troca só após 2 leituras; erro isolado é ignorado', () => {
    const tr = new CardTracker();
    tr.update([A, B, C], FRAME);
    const D = card('D', 959);
    assert.strictEqual(ids(tr.update([A, D, C], FRAME)), 'A,B,C'); // 1ª leitura com D
    assert.strictEqual(ids(tr.update([A, B, C], FRAME)), 'A,B,C'); // voltou B: era erro de OCR
    assert.strictEqual(ids(tr.update([A, D, C], FRAME)), 'A,B,C');
    assert.strictEqual(ids(tr.update([A, D, C], FRAME)), 'A,D,C'); // 2 seguidas: reroll confirmado
  });

  t('tracker: some só depois de 2 leituras vazias seguidas', () => {
    const tr = new CardTracker();
    tr.update([A, B, C], FRAME);
    assert.strictEqual(tr.update([], FRAME).visible, true);
    assert.strictEqual(tr.update([A], FRAME).visible, true); // 1 carta lida: sessão continua
    assert.strictEqual(tr.update([], FRAME).visible, true);
    const r = tr.update([], FRAME);
    assert.strictEqual(r.visible, false);
    assert.strictEqual(r.changed, true);
  });

  t('tracker: 1 carta isolada não abre sessão; 2 leituras seguidas abrem', () => {
    const tr = new CardTracker();
    assert.strictEqual(tr.update([A], FRAME).visible, false);
    assert.strictEqual(tr.update([A], FRAME).visible, true);
  });

  t('tracker: match por palavra única não desloca o slot', () => {
    const tr = new CardTracker();
    tr.update([A, B, C], FRAME);
    const partialB = { id: 'B', score: 0.7, partial: true, bbox: { x0: 1000, y0: 434, x1: 1080, y1: 456 } };
    const r = tr.update([A, partialB, C], FRAME);
    assert.strictEqual(Math.round(r.cards[1].cx), 959);
  });
};
