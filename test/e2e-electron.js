// Teste ponta a ponta com prints REAIS da tela de cartas (test/fixtures/): recorta a faixa padrão dos
// títulos, roda o OCR, passa pelo tracker e confere as 3 cartas de cada print. Uso: npm run test:e2e
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { DataStore } = require('../src/data');
const { AugmentMatcher, normalize } = require('../src/matcher');
const { createOcrWorker, recognize, upscaleFor, DEFAULT_REGION } = require('../src/ocr');
const { CardTracker } = require('../src/tracker');

// Os prints do Vel'Koz têm os selos da versão antiga do overlay sobre os títulos: servem de teste de robustez.
const FIXTURES = [
  ['cartas-warwick-1080p.webp', ['Transmutar: Prismático', 'Corpo Celestial', 'Recursão']],
  ['cartas-velkoz-1080p-a.webp', ['Aprimoramento – Fulgor', 'Transbordamento', 'Engenho do Encolhimento']],
  ['cartas-velkoz-1080p-b.webp', ['Aprimoramento – Fulgor', 'Transbordamento', 'Engenho do Encolhimento']],
];

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // não sair ao fechar a janela auxiliar
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(path.join(os.tmpdir(), 'mayhem-e2e.log'), s + '\n'); };
async function loadImage(file) {
  const win = new BrowserWindow({ width: 1920, height: 1080, show: false, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } });
  win.setContentSize(1920, 1080);
  const b64 = fs.readFileSync(file).toString('base64');
  await win.loadURL(`data:text/html,<body style="margin:0;overflow:hidden"><img style="display:block;width:1920px;height:1080px" src="data:image/webp;base64,${b64}"></body>`);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.capturePage();
  win.destroy();
  return img;
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const tmp = path.join(os.tmpdir(), 'mayhem-e2e');
    const store = new DataStore(path.join(tmp, 'cache'));
    await store.init();
    const matcher = new AugmentMatcher(store.augments);
    const worker = await createOcrWorker(path.join(tmp, 'tessdata'));
    for (const [file, expected] of FIXTURES) {
      const img = await loadImage(path.join(__dirname, 'fixtures', file));
      const sz = img.getSize();
      const r = DEFAULT_REGION;
      const rect = { x: Math.round(sz.width * r.x), y: Math.round(sz.height * r.y), width: Math.round(sz.width * r.w), height: Math.round(sz.height * r.h) };
      const crop = img.crop(rect);
      await recognize(worker, crop, { scale: upscaleFor(sz.height) }); // aquecimento
      const tracker = new CardTracker();
      const times = [];
      let tracked = null;
      let partial = 0;
      for (let i = 0; i < 3; i++) {
        const t = Date.now();
        const { lines } = await recognize(worker, crop, { scale: upscaleFor(sz.height) });
        times.push(Date.now() - t);
        const matches = matcher.match(lines, { frameHeight: sz.height });
        partial += matches.filter((m) => m.partial).length;
        tracked = tracker.update(matches.map((m) => ({ ...m, bbox: { x0: m.bbox.x0 + rect.x, y0: m.bbox.y0 + rect.y, x1: m.bbox.x1 + rect.x, y1: m.bbox.y1 + rect.y } })), sz);
      }
      const got = tracked.cards.map((c) => store.augments[c.id].namePt);
      const ok = JSON.stringify(got.map(normalize)) === JSON.stringify(expected.map(normalize));
      log(`${ok ? 'OK    ' : 'FALHOU'} ${file}: ${got.join(' | ')} · OCR ${times.join('/')} ms${partial ? ` · ${partial} por palavra única` : ''}`);
      if (!ok) {
        log('       esperado:', expected.join(' | '));
        code = 1;
      }
    }
    await worker.terminate();

    // Custo da captura de tela (só em memória, nada é salvo).
    const d = screen.getPrimaryDisplay();
    const t0 = Date.now();
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width * d.scaleFactor, height: d.size.height * d.scaleFactor } });
    log(`Captura de tela: ${Date.now() - t0} ms`);
    log(code ? 'E2E FALHOU' : 'E2E OK');
  } catch (e) {
    log('ERRO', e.stack);
    code = 1;
  }
  app.exit(code);
});
