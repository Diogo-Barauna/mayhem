// Helpers de OCR (tesseract.js).
const fs = require('fs');

// Faixa dos títulos das cartas (fração da tela), medida num print real 1920x1080 (títulos em ~41% da altura).
const DEFAULT_REGION = { x: 0.1, y: 0.37, w: 0.8, h: 0.1 };

async function createOcrWorker(cachePath, langs = ['por']) {
  const { createWorker } = require('tesseract.js');
  fs.mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker(langs, 1, { cachePath });
  await worker.setParameters({
    tessedit_pageseg_mode: '11', // texto esparso: bom para UI de jogo
    preserve_interword_spaces: '1',
  });
  return worker;
}

// Junta todas as palavras do OCR e remonta "linhas" por altura, quebrando em vãos grandes
// (cada carta vira um segmento separado).
function wordsToLines(data) {
  const words = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        for (const w of l.words || []) {
          if (w.text && w.text.trim() && w.confidence > 20) words.push({ text: w.text, bbox: w.bbox });
        }
      }
    }
  }
  words.sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const rows = [];
  for (const w of words) {
    const h = w.bbox.y1 - w.bbox.y0;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < Math.max(6, h * 0.6));
    if (row) row.words.push(w);
    else rows.push({ cy, words: [w] });
  }
  const lines = [];
  for (const r of rows) {
    r.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    let cur = [r.words[0]];
    for (let i = 1; i < r.words.length; i++) {
      const prev = r.words[i - 1];
      const w = r.words[i];
      const h = Math.max(prev.bbox.y1 - prev.bbox.y0, 8);
      if (w.bbox.x0 - prev.bbox.x1 > h * 2.5) {
        lines.push({ words: cur });
        cur = [];
      }
      cur.push(w);
    }
    lines.push({ words: cur });
  }
  return lines;
}

// image: Buffer PNG
async function recognize(worker, image) {
  const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
  return { lines: wordsToLines(data), text: data.text };
}

module.exports = { createOcrWorker, wordsToLines, recognize, DEFAULT_REGION };
