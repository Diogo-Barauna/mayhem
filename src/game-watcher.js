// Observa o ciclo de partidas pela Live Client Data API e decide quando uma partida começa ou termina.
// Puro (sem Electron) para ser testável: a consulta à API e as reações são injetadas.
//
// detect(): Promise<{ champion, gameMode, gameTime } | null>
//   - null: a API respondeu mas os dados ainda estão incompletos (tela de carregamento);
//   - lança erro: a API não respondeu (nenhuma partida aberta).
//
// Partida NOVA quando: não havia partida; o campeão mudou; o modo mudou; ou o gameTime voltou para trás
// (a API não tem ID de partida, então esse é o sinal de que outra partida começou sem o fim ter sido notado).
// Partida TERMINADA após `endAfterMisses` falhas seguidas da API.

class GameWatcher {
  constructor({ detect, onGameStart, onGameEnd, onError = () => {}, endAfterMisses = 2, timeRewindTolerance = 5 }) {
    this.detect = detect;
    this.onGameStart = onGameStart;
    this.onGameEnd = onGameEnd;
    this.onError = onError;
    this.endAfterMisses = endAfterMisses;
    this.timeRewindTolerance = timeRewindTolerance;
    this.current = null; // { champion, gameMode, gameTime }
    this.misses = 0;
    this.running = false;
  }

  // Devolve o que aconteceu neste tick (útil em testes e no log):
  // 'busy' | 'loading' | 'start' | 'same' | 'miss' | 'end' | 'idle'
  async tick() {
    if (this.running) return 'busy'; // tick anterior ainda rodando: não sobrepõe
    this.running = true;
    try {
      let game;
      try {
        game = await this.detect();
      } catch (_) {
        if (!this.current) return 'idle';
        if (++this.misses < this.endAfterMisses) return 'miss';
        await this._end();
        return 'end';
      }
      this.misses = 0;
      if (!game) return 'loading';

      if (this._isNewGame(game)) {
        if (this.current) await this._end();
        this.current = { ...game };
        await this._call(this.onGameStart, { ...game });
        return 'start';
      }
      if (typeof game.gameTime === 'number') this.current.gameTime = game.gameTime;
      return 'same';
    } finally {
      this.running = false;
    }
  }

  _isNewGame(g) {
    const c = this.current;
    if (!c) return true;
    if (String(g.champion).toLowerCase() !== String(c.champion).toLowerCase()) return true;
    if (g.gameMode !== c.gameMode) return true;
    if (typeof g.gameTime === 'number' && typeof c.gameTime === 'number' && g.gameTime < c.gameTime - this.timeRewindTolerance) return true;
    return false;
  }

  async _end() {
    const ended = this.current;
    this.current = null;
    this.misses = 0;
    await this._call(this.onGameEnd, ended);
  }

  // Erros nas reações (baixar dados, etc.) não podem ser confundidos com "a partida acabou".
  async _call(fn, arg) {
    try {
      await fn(arg);
    } catch (err) {
      this.onError(err);
    }
  }
}

// Possíveis IDs do campeão de um jogador da Live Client API, do mais confiável ao menos.
// O formato de rawChampionName varia de campeão para campeão NA MESMA partida (visto em 2026-11):
//   "game_character_displayname_Lissandra"  e  "Character_Aatrox_Name"
function championCandidates(player) {
  const out = [];
  const raw = (player && player.rawChampionName) || '';
  let m = raw.match(/^game_character_displayname_(.+)$/i) || raw.match(/^Character_(.+)_Name$/i);
  if (m) out.push(m[1]);
  m = ((player && player.rawSkinName) || '').match(/^game_character_skin_displayname_(.+?)_\d+$/i);
  if (m) out.push(m[1]);
  if (player && player.championName) out.push(player.championName); // nome exibido (pode estar traduzido)
  if (raw && !out.length) out.push(raw);
  return [...new Set(out)];
}

module.exports = { GameWatcher, championCandidates };
