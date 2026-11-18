# Mayhem Augment Helper

App para Windows que lê a tela durante o **ARAM: Mayhem** do League of Legends, reconhece as 3 cartas
(augments) oferecidas e mostra por cima do jogo qual é a melhor para o seu campeão.

## Como usar

```bash
npm install
npm start
```

1. Abra o app e deixe-o aberto (pode minimizar). **Não é preciso escolher campeão.** Quando a partida carrega,
   o app descobre o seu campeão pela Live Client Data API da Riot (`https://127.0.0.1:2999`, local e oficial),
   baixa os dados dele e começa a ler a tela. Quando a partida acaba, ele para de ler e volta a aguardar.
   Em modos que não têm as cartas do Mayhem (Summoner's Rift, Arena e outros) a tela não é lida.
2. Jogue com o LoL em **Tela cheia sem bordas (Borderless)** ou **Janela**. Em tela cheia exclusiva o
   Windows não deixa sobrepor janelas, e a captura pode sair preta.
3. Quando as cartas aparecem, cada uma ganha um selo com o tier (S/A/B/C/D) e a posição; a melhor fica
   destacada com **★ MELHOR**. O overlay aparece cerca de 1 s depois das cartas e some cerca de 1 s depois que
   você escolhe. Ele não recebe cliques: eles passam direto para o jogo.

**Testar com print:** tire um print da tela de cartas (Win+Shift+S ou PrtSc) e use o botão
"Testar com print" para ver o que o OCR leu e quais cartas reconheceu. Fora de partida ele mostra só os nomes,
sem ranking, porque ainda não há campeão detectado.

**Configurações (⚙):**
- monitor do jogo;
- idioma do cliente (Português, English ou os dois, que é mais lento);
- intervalo entre leituras;
- faixa da tela com os **títulos** das cartas. O padrão é 10–90% na horizontal e 37–47% na vertical, medido
  num print real em 1920×1080.

Se o reconhecimento falhar, ative "Salvar a última captura", abra a pasta de dados e confira se os títulos
estão dentro da faixa.

## De onde vêm os dados

A Riot não expõe os augments em nenhuma API oficial: nem as cartas oferecidas na partida, nem estatísticas.
Por isso a leitura é feita por OCR na tela, e as estatísticas vêm de sites da comunidade. Fontes avaliadas:

| Fonte | Como acessar | Dados | Usado |
|---|---|---|---|
| **Blitz.gg** | API JSON pública que o próprio site usa (`data.v2.iesdev.com`, `utils.iesdev.com`) | Tier 1–5 de **cada augment por campeão**; nomes PT-BR/EN; ícones | ✅ principal |
| **op.gg** | A página `op.gg/lol/modes/aram-mayhem/<campeão>/augments` traz no HTML o JSON do Next.js | `performance`, `popular` (pick rate %) e tier por augment/campeão | ✅ complementar |
| Data Dragon (Riot) | `ddragon.leagueoflegends.com` | Lista de campeões e ícones | ✅ |
| Live Client Data API (Riot) | `https://127.0.0.1:2999/liveclientdata/allgamedata` | Campeão e modo da partida em andamento (detecção automática) | ✅ |
| METAsrc | — | Bloqueia scraping (HTTP 403) | ❌ |
| arammayhem.com, hexgate.app | HTML | Tier lists e builds; sem JSON fácil | ❌ (alternativas) |
| Wiki do LoL (`Module:MayhemAugmentData/data`) | Tabela Lua | Descrições e tiers gerais (não por campeão) | ❌ |

Endpoints usados:

- `https://utils.iesdev.com/static/json/lol/mayham/<patch>/augments_en_us` (e `_pt_br`): catálogo de augments por ID.
- `https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/aram_mayhem_champion?champion_id=<key>`: tiers por campeão.
- `https://op.gg/lol/modes/aram-mayhem/<id-ddragon-minúsculo>/augments`: o parser procura `"data":[{"id":…,"performance":…}]` no payload `self.__next_f`.

As duas fontes usam os mesmos IDs de augment da Riot, então os dados se cruzam direto.

**Score (0–100):** combina o tier do Blitz (1→95 … 5→25) com a `performance` do op.gg normalizada.
O op.gg pesa até 50%, e menos quando o pick rate é baixo (amostra pequena). Entradas do op.gg com pick rate 0
são ignoradas, porque são placeholders sem jogos.

Os dados ficam em cache por 6 h em `%APPDATA%/mayhem-augment-helper/cache` (2 requisições por campeão). Se você
estiver sem internet ou o site estiver fora do ar, o app usa o cache antigo.

> ⚠️ Esses endpoints não são APIs públicas documentadas e podem mudar sem aviso. Se uma fonte quebrar, o app
> continua com a outra; o cabeçalho do campeão mostra quais fontes responderam. Use com moderação e respeite os
> termos de uso dos sites.

## Como a leitura funciona

1. A tela é capturada (~0,2 s) e só a faixa dos títulos é recortada.
2. O recorte é ampliado (1,5× em 1080p) e passa pelo OCR (tesseract.js), em ~0,5 s.
3. O texto é comparado com os nomes dos augments em PT-BR e EN, tolerando erros pequenos de leitura.
4. Só valem títulos na **mesma altura**, o que descarta a tag da carta ("Resiliência", "Utilidade"…) e o texto
   das descrições.
5. Se uma carta não foi lida inteira, uma palavra exclusiva de um nome, na mesma altura dos outros títulos,
   basta para identificá-la. Por exemplo, "ão Celestial" vira Corpo Celestial.

## Estrutura

```
src/main.js       processo principal: janelas, captura da tela, loop de leitura, Live Client API
src/data.js       coleta, cache e combinação dos dados (Blitz + op.gg + Data Dragon)
src/ocr.js        tesseract.js, ampliação do recorte e remontagem das linhas
src/matcher.js    casa o texto do OCR com os nomes dos augments
src/renderer/     janela principal
src/overlay/      overlay transparente sobre o jogo
test/             testes unitários, teste ponta a ponta e o print usado nele
```

## Testes

```bash
npm test
```

```bash
npm run test:e2e
```

O teste ponta a ponta usa um print real da tela de cartas (`test/fixtures/cartas-warwick-1080p.webp`). Ele
recorta a faixa padrão, roda o OCR de verdade, confere as 3 cartas e mostra o tempo de cada leitura.

## Limitações conhecidas

- Durante a partida, a leitura ocupa um núcleo de CPU. Use "Pausar" se quiser desligá-la.
- A faixa padrão foi calibrada com um print 16:9. Em outras proporções (ultrawide, 16:10) pode ser preciso
  ajustá-la em Configurações.
- Em tela cheia exclusiva o overlay não aparece. Use Borderless.
- Funciona com o cliente em PT-BR ou EN (escolha em Configurações). Outros idiomas exigem adicionar o idioma
  no OCR e os nomes no catálogo (`augments_<locale>` em `src/data.js`).
