// Testes do GameWatcher (ciclo de partidas).
const assert = require('assert');
const { GameWatcher, championCandidates } = require('../src/game-watcher');

module.exports = (t, defer) => {
  t('candidatos do campeão: todos os formatos vistos na Live Client API', () => {
    assert.deepStrictEqual(championCandidates({ rawChampionName: 'game_character_displayname_Lissandra', championName: 'Lissandra' }), ['Lissandra']);
    assert.deepStrictEqual(
      championCandidates({ rawChampionName: 'Character_Aatrox_Name', rawSkinName: 'game_character_skin_displayname_Aatrox_7', championName: 'Aatrox' }),
      ['Aatrox'],
    );
    assert.deepStrictEqual(championCandidates({ rawChampionName: 'Character_MonkeyKing_Name', championName: 'Wukong' }), ['MonkeyKing', 'Wukong']);
    assert.deepStrictEqual(championCandidates({ rawChampionName: 'algo_novo', championName: "Vel'Koz" }), ["Vel'Koz"]);
    // Só a skin informa o ID (formato de rawChampionName desconhecido).
    assert.deepStrictEqual(
      championCandidates({ rawChampionName: 'outro_formato', rawSkinName: 'game_character_skin_displayname_Velkoz_3', championName: "Vel'Koz" }),
      ['Velkoz', "Vel'Koz"],
    );
  });

  // detect simulado: cada passo é um objeto de partida, null (carregando) ou 'down' (API fora do ar).
  function make(steps, extra = {}) {
    const events = [];
    let i = 0;
    const w = new GameWatcher({
      detect: async () => {
        const s = steps[Math.min(i++, steps.length - 1)];
        if (s === 'down') throw new Error('ECONNREFUSED');
        return s;
      },
      onGameStart: async (g) => { events.push(`start:${g.champion}`); },
      onGameEnd: async (g) => { events.push(`end:${g.champion}`); },
      onError: (e) => events.push(`error:${e.message}`),
      ...extra,
    });
    return { w, events, run: async (n) => { for (let k = 0; k < n; k++) await w.tick(); } };
  }
  const ahri = (time) => ({ champion: 'Ahri', gameMode: 'KIWI', gameTime: time });
  const wukong = (time) => ({ champion: 'MonkeyKing', gameMode: 'KIWI', gameTime: time });

  defer('watcher: fim por falhas da API e nova partida com outro campeão', async () => {
    const { events, run } = make([ahri(10), ahri(20), 'down', 'down', 'down', wukong(3), wukong(6)]);
    await run(7);
    assert.deepStrictEqual(events, ['start:Ahri', 'end:Ahri', 'start:MonkeyKing']);
  });

  defer('watcher: troca de campeão sem falhas entre as partidas', async () => {
    const { events, run } = make([ahri(10), ahri(900), wukong(2)]);
    await run(3);
    assert.deepStrictEqual(events, ['start:Ahri', 'end:Ahri', 'start:MonkeyKing']);
  });

  defer('watcher: mesmo campeão, gameTime volta para trás = nova partida', async () => {
    const { events, run } = make([ahri(800), ahri(900), ahri(5)]);
    await run(3);
    assert.deepStrictEqual(events, ['start:Ahri', 'end:Ahri', 'start:Ahri']);
  });

  defer('watcher: tela de carregamento (null) e 1 falha isolada não encerram', async () => {
    const { events, run } = make([ahri(10), null, 'down', ahri(15), null, ahri(20)]);
    await run(6);
    assert.deepStrictEqual(events, ['start:Ahri']);
  });

  defer('watcher: erro ao carregar dados não conta como fim de partida', async () => {
    const events = [];
    const w = new GameWatcher({
      detect: async () => ahri(10),
      onGameStart: async () => { events.push('start'); throw new Error('download falhou'); },
      onGameEnd: async () => events.push('end'),
      onError: (e) => events.push(`error:${e.message}`),
    });
    await w.tick();
    await w.tick();
    await w.tick();
    assert.deepStrictEqual(events, ['start', 'error:download falhou']);
  });

  defer('watcher: tick reentrante é ignorado enquanto o anterior roda', async () => {
    let release;
    const w = new GameWatcher({
      detect: () => new Promise((r) => { release = () => r(ahri(10)); }),
      onGameStart: async () => {},
      onGameEnd: async () => {},
    });
    const first = w.tick();
    assert.strictEqual(await w.tick(), 'busy');
    release();
    assert.strictEqual(await first, 'start');
  });
};
