// Coleta e cache dos dados de augments do ARAM Mayhem.
//
// Fontes (todas sem login, com cache local para fazer poucas requisições):
//  - Blitz.gg (API JSON pública que o próprio site usa):
//      utils.iesdev.com/static/json/lol/mayham/<patch>/augments_<locale>  -> nomes/raridade/ícones por ID
//      data.v2.iesdev.com/.../aram_mayhem_champion?champion_id=<id>       -> tier (1..5) de cada augment p/ o campeão
//  - op.gg: a página /lol/modes/aram-mayhem/<champ>/augments embute no payload do Next.js
//      um JSON com {id, tier, performance, popular, name} de cada augment para o campeão.
//  - Data Dragon (Riot): lista de campeões e ícones.
// Os IDs de augment são os mesmos da Riot nas duas fontes, então dá para cruzar os dados.

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TTL_MS = 6 * 60 * 60 * 1000; // 6h
const FETCH_TIMEOUT_MS = 10000; // sem isso, um site que não responde trava a carga do campeão para sempre

class DataStore {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    fs.mkdirSync(cacheDir, { recursive: true });
    this.patch = null;
    this.ddVersion = null;
    this.champions = []; // {key, id, name, icon}
    this.augments = {}; // id -> {id, names: [..], name, namePt, rarity, icon}
  }

  // ---------- cache/http helpers ----------
  _cachePath(key) {
    return path.join(this.cacheDir, key.replace(/[^a-z0-9_.-]/gi, '_'));
  }

  async _get(url, { cacheKey, ttl = TTL_MS, type = 'json' } = {}) {
    const file = cacheKey ? this._cachePath(cacheKey) : null;
    if (file && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < ttl) {
      const raw = fs.readFileSync(file, 'utf8');
      return type === 'json' ? JSON.parse(raw) : raw;
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
      const text = await res.text();
      const value = type === 'json' ? JSON.parse(text) : text;
      if (file) fs.writeFileSync(file, type === 'json' ? JSON.stringify(value) : text);
      return value;
    } catch (err) {
      // Sem internet / fonte fora do ar: usa cache vencido se existir.
      if (file && fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        return type === 'json' ? JSON.parse(raw) : raw;
      }
      throw err;
    }
  }

  // ---------- inicialização ----------
  async init() {
    const ddVersions = await this._get('https://ddragon.leagueoflegends.com/api/versions.json', { cacheKey: 'dd_versions.json' });
    this.ddVersion = ddVersions[0];

    const champJson = await this._get(
      `https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/data/pt_BR/champion.json`,
      { cacheKey: `dd_champions_${this.ddVersion}.json`, ttl: 7 * 24 * 3600e3 }
    );
    this.champions = Object.values(champJson.data)
      .map((c) => ({
        key: c.key,
        id: c.id,
        name: c.name,
        icon: `https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/img/champion/${c.id}.png`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    // Patch que o Blitz tem dados (pode estar 1 atrás do Data Dragon).
    const blitzVersions = await this._get('https://utils.iesdev.com/static/json/lol/riot/versions', { cacheKey: 'blitz_versions.json' });
    const candidates = blitzVersions.slice(0, 4).map((v) => v.split('.').slice(0, 2).join('.'));
    let en = null;
    let pt = null;
    for (const p of candidates) {
      try {
        en = await this._get(`https://utils.iesdev.com/static/json/lol/mayham/${p}/augments_en_us`, { cacheKey: `aug_${p}_en.json` });
        pt = await this._get(`https://utils.iesdev.com/static/json/lol/mayham/${p}/augments_pt_br`, { cacheKey: `aug_${p}_pt.json` }).catch(() => ({}));
        this.patch = p;
        break;
      } catch (_) { /* tenta o patch anterior */ }
    }
    if (!en) throw new Error('Não foi possível baixar a lista de augments do Mayhem.');

    this.augments = {};
    for (const [id, a] of Object.entries(en)) {
      if (a.enabled === false) continue;
      const namePt = pt[id] && pt[id].displayName;
      this.augments[id] = {
        id,
        name: a.displayName,
        namePt: namePt || a.displayName,
        names: [...new Set([a.displayName, namePt].filter(Boolean))],
        rarity: a.rarity, // 0 = prismático, 1 = ouro, 2 = prata (padrão do Blitz)
        icon: a.iconLarge ? `https://blitz-cdn.blitz.gg/blitz/lol/arena/augments/${a.iconLarge.replace('.png', '.webp')}` : null,
      };
    }
    return { patch: this.patch, champions: this.champions.length, augments: Object.keys(this.augments).length };
  }

  findChampion(query) {
    if (!query) return null;
    const q = String(query).toLowerCase().replace(/[^a-z0-9]/g, '');
    return this.champions.find(
      (c) => c.key === String(query) || c.id.toLowerCase() === q || c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === q
    ) || null;
  }

  // ---------- estatísticas por campeão ----------
  async _blitzChampion(champ) {
    const url = `https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champion?champion_id=${champ.key}`;
    const j = await this._get(url, { cacheKey: `blitz_champ_${this.patch}_${champ.key}.json` });
    const d = j && j.data && j.data[0] && j.data[0].data;
    return (d && d.augments) || {};
  }

  async _opggChampion(champ) {
    const url = `https://op.gg/lol/modes/aram-mayhem/${champ.id.toLowerCase()}/augments`;
    const html = await this._get(url, { cacheKey: `opgg_${this.patch}_${champ.id}.html`, type: 'text' });
    return parseOpggAugments(html);
  }

  // Retorna um mapa augmentId -> {score, tierLabel, blitzTier, opggPerf, opggPick}
  async championStats(champ) {
    const [blitz, opgg] = await Promise.allSettled([this._blitzChampion(champ), this._opggChampion(champ)]);
    const b = blitz.status === 'fulfilled' ? blitz.value : {};
    const o = opgg.status === 'fulfilled' ? opgg.value : [];
    const opggById = {};
    // popular === 0 são placeholders do op.gg (performance 170, sem jogos).
    for (const a of o) if (a.popular > 0 && a.performance <= 100) opggById[String(a.id)] = a;

    const out = {};
    const ids = new Set([...Object.keys(b), ...Object.keys(opggById)]);
    for (const id of ids) {
      const bt = b[id] && b[id].tier;
      const op = opggById[id];
      out[id] = {
        blitzTier: bt ?? null,
        opggPerf: op ? op.performance : null,
        opggPick: op ? op.popular : null,
        opggTier: op ? op.tier : null,
        score: combineScore(bt, op && op.performance, op && op.popular),
      };
      // op.gg pode conhecer augments novos que a lista do Blitz ainda não tem.
      if (!this.augments[id] && op && op.name) {
        this.augments[id] = { id, name: op.name, namePt: op.name, names: [op.name], rarity: op.rarity, icon: op.largeIcon };
      }
    }
    return {
      stats: out,
      sources: {
        blitz: blitz.status === 'fulfilled' && Object.keys(b).length > 0,
        opgg: opgg.status === 'fulfilled' && o.length > 0,
      },
    };
  }
}

// Score 0..100.
//  - Blitz: tier 1 (melhor) .. 5 (pior) do augment para o campeão.
//  - op.gg: "performance" (~55..98; medido: tier 1 do Blitz ≈ 91.7, tier 5 ≈ 79.5) e "popular" (pick rate %).
// O op.gg pesa menos quando o pick rate é baixo (amostra pequena).
function combineScore(blitzTier, opggPerf, opggPick = 1) {
  const tierScore = blitzTier ? ({ 1: 95, 2: 78, 3: 60, 4: 42, 5: 25 }[blitzTier] ?? 50) : null;
  const perfScore = opggPerf != null ? Math.max(0, Math.min(100, (opggPerf - 75) * 5)) : null;
  let score;
  if (tierScore != null && perfScore != null) {
    const w = opggPick >= 0.3 ? 0.5 : opggPick >= 0.1 ? 0.35 : 0.15;
    score = w * perfScore + (1 - w) * tierScore;
  } else {
    score = tierScore ?? perfScore;
  }
  return score == null ? null : Math.round(score * 10) / 10;
}

function scoreToTier(score) {
  if (score == null) return '?';
  if (score >= 80) return 'S';
  if (score >= 65) return 'A';
  if (score >= 50) return 'B';
  if (score >= 35) return 'C';
  return 'D';
}

// Extrai o array de augments do payload RSC (self.__next_f.push) da página do op.gg.
function parseOpggAugments(html) {
  let payload = '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html))) {
    try { payload += JSON.parse(m[1]); } catch (_) { /* ignora pedaço malformado */ }
  }
  const marker = '"data":[{"id":';
  let idx = payload.indexOf(marker);
  while (idx !== -1) {
    const start = idx + '"data":'.length;
    const arr = sliceBalanced(payload, start);
    if (arr && arr.includes('"performance"')) {
      try {
        return JSON.parse(arr).filter((a) => a && a.id != null && a.performance != null);
      } catch (_) { /* tenta a próxima ocorrência */ }
    }
    idx = payload.indexOf(marker, idx + 1);
  }
  return [];
}

function sliceBalanced(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

module.exports = { DataStore, parseOpggAugments, combineScore, scoreToTier };
