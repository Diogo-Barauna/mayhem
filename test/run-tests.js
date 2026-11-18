// Testes do matcher e do parser do op.gg (sem rede).
const assert = require('assert');
const { AugmentMatcher, normalize } = require('../src/matcher');
const { parseOpggAugments, combineScore, scoreToTier } = require('../src/data');

const augments = {
  1030: { id: '1030', names: ['Eureka', 'Eureca'] },
  1068: { id: '1068', names: ['Recursion', 'Recursão'] },
  2132: { id: '2132', names: ['Warlock Juicebox', 'Suquinho do Bruxo'] },
  1048: { id: '1048', names: ['Jeweled Gauntlet', 'Manopla Cravejada'] },
  1238: { id: '1238', names: ['Transmute: Prismatic', 'Transmutar: Prismático'] },
  9999: { id: '9999', names: ['BEES!!!', 'ABELHAS!!!'] },
};
const m = new AugmentMatcher(augments);
const w = (text, x0, y0, wid = text.length * 12, h = 22) => ({ text, bbox: { x0, y0, x1: x0 + wid, y1: y0 + h } });
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('normaliza acentos e pontuação', () => {
  assert.strictEqual(normalize('Transmutar: Prismático'), 'transmutar prismatico');
});

t('3 cartas na mesma linha do OCR (PT-BR, com erros de OCR)', () => {
  const lines = [{ words: [w('Suquinho', 100, 400), w('do', 210, 400), w('Bruxo', 240, 400), w('Eureca', 700, 402), w('Manopla', 1200, 401), w('Cravejacla', 1300, 401)] }];
  const r = m.match(lines, { frameHeight: 1080 });
  assert.deepStrictEqual(r.map((x) => x.id), ['2132', '1030', '1048']);
});

t('ignora nome citado na descrição (altura diferente)', () => {
  const lines = [
    { words: [w('Recursion', 100, 400)] },
    { words: [w('Eureka', 700, 400)] },
    { words: [w('Transmute:', 1200, 400), w('Prismatic', 1330, 400)] },
    { words: [w('Gain', 100, 600), w('a', 150, 600), w('random', 170, 600), w('Recursion', 260, 600)] },
  ];
  const r = m.match(lines, { frameHeight: 1080 });
  assert.deepStrictEqual(r.map((x) => x.id), ['1068', '1030', '1238']);
});

t('não casa texto aleatório', () => {
  const lines = [{ words: [w('Escolha', 100, 100), w('um', 200, 100), w('aprimoramento', 240, 100)] }];
  assert.strictEqual(m.match(lines).length, 0);
});

t('parser do op.gg extrai o JSON do payload Next.js', () => {
  const inner = '68:["$","$L69",null,{"data":[{"id":2132,"tier":0,"performance":90.61,"popular":3.83,"name":"Warlock Juicebox"}]}]';
  const html = `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`;
  const r = parseOpggAugments(html);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].performance, 90.61);
});

t('score combinado e tier', () => {
  assert.strictEqual(scoreToTier(combineScore(1, 95, 2)), 'S');
  assert.strictEqual(scoreToTier(combineScore(5, 78, 0.05)), 'D');
  assert.strictEqual(combineScore(null, null), null);
});

console.log(`\n${n} testes passaram.`);
