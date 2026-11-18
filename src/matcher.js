// Casa o texto lido pelo OCR com os nomes de augments (PT-BR e EN).
// Entrada: linhas do OCR com palavras e bounding boxes. Saída: as cartas encontradas (2-3) com posição.

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  // Compara sem espaços: o OCR costuma juntar/separar palavras.
  const x = a.replace(/ /g, '');
  const y = b.replace(/ /g, '');
  if (!x.length || !y.length) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// Nomes curtos exigem casamento quase exato para evitar falsos positivos.
function minScoreFor(name) {
  const len = name.replace(/ /g, '').length;
  if (len <= 4) return 1;
  if (len <= 7) return 0.86;
  return 0.8;
}

class AugmentMatcher {
  constructor(augments) {
    this.setAugments(augments);
  }

  setAugments(augments) {
    this.entries = [];
    for (const a of Object.values(augments)) {
      for (const n of a.names || [a.name]) {
        const norm = normalize(n);
        if (norm) this.entries.push({ id: a.id, norm, words: norm.split(' ').length });
      }
    }
    this.maxWords = Math.max(1, ...this.entries.map((e) => e.words)) + 1;
  }

  bestFor(text) {
    let best = null;
    for (const e of this.entries) {
      if (Math.abs(e.norm.length - text.length) > Math.max(4, e.norm.length * 0.4)) continue;
      const s = similarity(text, e.norm);
      if (s >= minScoreFor(e.norm) && (!best || s > best.score)) best = { id: e.id, score: s, norm: e.norm };
    }
    return best;
  }

  // lines: [{ words: [{text, bbox:{x0,y0,x1,y1}}] }]
  // Retorna [{id, score, bbox}] ordenado da esquerda p/ direita (cartas 1..3).
  match(lines, { frameHeight = 1080 } = {}) {
    const found = [];
    for (const line of lines) {
      const words = (line.words || [])
        .map((w) => ({ ...w, norm: normalize(w.text) }))
        .filter((w) => w.norm);
      // Janela deslizante de palavras: a mesma linha do OCR pode conter os títulos das 3 cartas.
      const cands = [];
      for (let i = 0; i < words.length; i++) {
        let text = '';
        for (let j = i; j < Math.min(words.length, i + this.maxWords); j++) {
          text = text ? `${text} ${words[j].norm}` : words[j].norm;
          const m = this.bestFor(text);
          if (m) cands.push({ ...m, i, j, len: j - i + 1 });
        }
      }
      // Escolhe candidatos sem sobreposição, priorizando score alto e janelas maiores.
      cands.sort((a, b) => b.score - a.score || b.len - a.len);
      const used = new Set();
      for (const c of cands) {
        let free = true;
        for (let k = c.i; k <= c.j; k++) if (used.has(k)) free = false;
        if (!free) continue;
        for (let k = c.i; k <= c.j; k++) used.add(k);
        const ws = words.slice(c.i, c.j + 1);
        found.push({
          id: c.id,
          score: c.score,
          bbox: {
            x0: Math.min(...ws.map((w) => w.bbox.x0)),
            y0: Math.min(...ws.map((w) => w.bbox.y0)),
            x1: Math.max(...ws.map((w) => w.bbox.x1)),
            y1: Math.max(...ws.map((w) => w.bbox.y1)),
          },
        });
      }
    }
    if (!found.length) return [];

    // Os títulos das cartas ficam na mesma altura. Agrupa por Y e fica com o maior grupo
    // (descarta nomes de augments citados dentro de descrições).
    const tol = frameHeight * 0.04;
    let bestGroup = [];
    for (const f of found) {
      const cy = (f.bbox.y0 + f.bbox.y1) / 2;
      const group = found.filter((g) => Math.abs((g.bbox.y0 + g.bbox.y1) / 2 - cy) <= tol);
      const sum = (arr) => arr.reduce((s, x) => s + x.score, 0);
      if (group.length > bestGroup.length || (group.length === bestGroup.length && sum(group) > sum(bestGroup))) bestGroup = group;
    }
    // Remove duplicados (mesmo augment lido duas vezes) e limita a 3 cartas.
    const byId = new Map();
    for (const g of bestGroup) if (!byId.has(g.id) || byId.get(g.id).score < g.score) byId.set(g.id, g);
    return [...byId.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
  }
}

module.exports = { AugmentMatcher, normalize, similarity };
