# Catan in Three.js

A 3D Catan game for the browser, phones and tablets. The island is procedural and uses
physically based materials: tile shapes, rivers, cliffs and props are generated at load time
from noise functions, and surfaces use CC0 PBR texture sets and a sky HDRI streamed from Poly
Haven. The only front-end dependency is Three.js, loaded from a CDN through an import map, so
there is no build step. An internet connection is required for the textures (about 10 MB on
first load, cached afterwards).

It plays offline against bots (hot seat for several people on one device) or online in rooms
of 2-6 players through the small Node server in `../server`.

## Run

**Everything (accounts, lobby, online rooms, leaderboard):**

```
cd server
npm install
npm start            # http://localhost:8080
```

The server serves this folder too, so open <http://localhost:8080/>, sign up (or play as a
guest) and create a room. Friends on the same network join with your machine's address, for
example `http://192.168.1.20:8080/`.

**Offline only (bots and hot seat, no accounts):** any static server works, since module
scripts cannot load from `file://`:

```
cd web
python -m http.server 8080
```

Open <http://localhost:8080/>; the landing page notices there is no game server and offers
*Play offline*, or go straight to <http://localhost:8080/play.html>.

## Pages

| Page | What it is |
| --- | --- |
| `index.html` | Landing page (log in, sign up, guest, offline) and, once logged in, the lobby: quick play against bots, create / join rooms, room seats and chat, lobby chat, leaderboard, skins. Loads no Three.js. |
| `play.html` | The game. Offline from the URL parameters below, online with `?room=CODE`. |

### `play.html` URL parameters

| Parameter | Example | Effect |
| --- | --- | --- |
| `variant` | `?variant=extension` | Board: `classic`, `balanced` (no 6/8 neighbours) or `extension` (30 tiles, up to 6 players). |
| `players` | `&players=6` | Number of seats, within the variant's range. |
| `seats` | `&seats=human,easy,medium,hard` | Who plays each seat in turn order (red, blue, white, orange, green, brown). |
| `seed` | `&seed=42` | Deterministic board; random when left out. |
| `timer` | `&timer=60` | Seconds per turn; `0` turns the clock off (default: the settings panel, 90). |
| `room` | `?room=4F68EA` | Join a running online game (the lobby sends you here). |
| `quality` | `&quality=low` | `low` drops the AO pass, uses smaller shadow / reflection maps and 1k textures. Touch devices get it automatically; `high` forces the full pipeline. |
| `maxfps` | `&maxfps=30` | Caps the frame rate (battery saving, automated tests). |
| `tex` | `&tex=1k` | Skip the 2k terrain texture upgrade. |
| `fast` | `&fast=1` | No pacing and no dice animation (automated tests). |
| `setup` | `&setup=auto` | Skip the opening draft and place everyone's first pieces automatically. |
| `cam`, `target` | `&cam=0,8,10` | Initial camera position / orbit target. |
| `sw` | `&sw=0` | Do not register the service worker. |

`quality`, `maxfps`, `tex` and `sw` on the lobby URL carry over into the games it starts.

## Screen layout

- **Seats** sit around the screen edges in turn order (red top left, then clockwise; seats 5
  and 6 take the middle of the right and left edges). Each shows an avatar, the name, who
  plays it (in offline games a Human / Easy / Medium / Hard picker), public victory points and
  stats: resource cards, development cards, road length, knights and harbours. Longest road
  and largest army are highlighted.
- **Turn clock**: the active seat shows the time left as a number and as an outline in the
  player's colour running down around its panel, red for the last 10 seconds (with ticks on
  your own turn). Out of time, the turn is finished for the player (roll, robber, card
  choices) and play passes on. Online, the host holds the clock until everyone has loaded.
- **Dock** (bottom): your hand, the dice, *Roll*, *Trade*, *Cards*, *End turn* and the
  settings gear. Keyboard: `R` rolls, `E` ends the turn, `V` resets the view, `M` toggles
  the minimap.
- **Tool column** (right edge): *reset view* (glides back to the default framing of the whole
  table), *minimap*, then chat, log and stats.
- **Minimap** (below the top-left seat): a flat north-up map with every hut, house, road,
  harbour, number and the robber, and an arrow for where the camera looks from. Click a tile
  to fly the camera there. Open by default on large screens; the choice is remembered.
- **Always visible pieces**: parts of huts, houses and roads hidden behind trees, mountains
  or other pieces are drawn through them as a translucent silhouette in the player's colour,
  so nothing disappears when you orbit the island.
- **Dice**: two 3D dice are thrown at the island, bounce and land on the rolled faces before
  production is paid out; the dock dice shake meanwhile.
- **Turn banner**: "Your turn" / "Blue's turn" fades in at each turn change.
- **Drawer** (buttons on the right edge): *Chat* (with quick emoji; bots chime in now and
  then), *Log* (every roll, build, trade, robber move and card, grouped by turn) and *Stats*
  (dice histogram against the expected counts, per player: cards produced, stolen / lost,
  trades, roads / huts / houses built, development cards, knights, road length).
- **Settings** (gear): volume and mute, bot speed (slow / normal / fast / instant), turn
  timer, your piece skin, graphics quality, slow auto-orbit, reset view, new board, leave.
- **End of game**: the winner, final points including hidden victory point cards, and the
  full statistics, with *Play again* (offline) and *Back to lobby*.

The camera is bounded: it orbits the island, zoom stays within a range around the distance
that fits the whole board (larger for the 6-player island), panning keeps the centre over the
island, and the framing is recomputed on every resize or rotation.

## Pieces, skins and sounds

Settlements are **huts** and cities are **houses**, modelled at a size that reads against
the tiles and the trees; placing one clears the props it stands on and it pops in with a
short bounce. Every model comes in skins (`src/skins.js`, catalogue in `src/catalog.js`):

| Skin | Rarity | Hut | House |
| --- | --- | --- | --- |
| Village | Common (free) | round wattle hut, dyed thatch cone | two-storey timber-framed house, stone ground floor, chimney |
| Stonework | Rare, 450 | stone cottage, coloured roof | hall with a spired tower and pennant |
| Nordic | Rare, 450 | turf longhouse with gable horns | long mead hall with a carved post and banner |
| Royal Gold | Legendary, 1200 | marble and gold hut | marble and gold house |

Accounts own skins (everyone starts with Village) and earn coins from online games (50 for a
win, 10 otherwise); the store that spends them is the next step. Online, each seat shows its
owner's equipped skin to everybody. Offline, any skin can be previewed on your own pieces.

Sounds are synthesised with the Web Audio API (no files): wooden knocks for roads, hammering
for huts, stone and a chime for houses, dice rattle and landing, a low swell for the robber,
a swipe for a steal, coins for trades, a card flick, a blade for knights, a bell on your
turn, fanfare on a win, clock ticks in the last seconds.

## Online play

The server (`../server`, Node 20+, one dependency: `ws`) provides:

- **Accounts**: sign up / log in (passwords hashed with scrypt, bearer session tokens),
  guests (unranked), the equipped skin and owned skins, coins.
- **Lobby**: open rooms with live seat counts, join by list or by 6-letter code, lobby chat.
- **Rooms**: name, board variant, 2-6 seats (limited by the variant), turn timer, which bots
  fill empty seats, private (code only). Players mark *ready*; the host starts. Room chat
  continues into the game.
- **Game relay**: the host's browser runs the authoritative game (rules, bots, dice). Other
  players' browsers mirror it: they send their moves as intents, the host applies them and
  broadcasts snapshots. The server hides other players' hands and development cards before
  relaying, keeps the latest state so a reloaded page resumes, gives a seat to a bot when a
  player stays away for 10 s (and back when they return), and hands hosting to another
  player if the host is gone for 15 s.
- **Leaderboard**: the host reports the result once; the winner gains 12 + 6 per opponent,
  others lose 8. Ranked by rating; guests excluded.

| Endpoint | |
| --- | --- |
| `POST /api/signup`, `/api/login`, `/api/guest` | `{ username, password }` / `{ name }` -> `{ token, user }` |
| `GET /api/me`, `POST /api/logout`, `POST /api/me/skin` | Bearer token |
| `GET /api/leaderboard`, `/api/variants`, `/api/health` | Public |
| `GET /ws?token=...` | WebSocket: lobby, rooms, chat, game relay |

Configuration: `PORT` (8080), `WEB_ROOT` (`../web`), `DATA_FILE` (`server/data/db.json`, a
JSON store; move to a database when it grows). To deploy, run the server on any Node host
(Render, Railway, Fly.io, a VPS) behind HTTPS. If the front end is hosted elsewhere (GitHub
Pages, the iOS app), put the server address in the `catan-server` meta tag of `index.html`
and `play.html`.

## iOS

1. **Home-screen web app (no Mac needed).** Serve the app over HTTPS (the Node server on a
   host, or `web/` on a static host with the `catan-server` meta tag pointing at the server),
   open it in Safari, then *Share -> Add to Home Screen*. It launches full screen with its own
   icon, respects the notch and home bar, and `sw.js` caches the pages, three.js and the
   textures.
2. **Native app with Capacitor (needs a Mac with Xcode).** `../mobile` wraps the same files:

   ```
   cd mobile
   npm install
   npm run ios:add     # copies ../web into www/ and creates the Xcode project
   npm run ios:open    # opens Xcode: pick a team, then run on a device or publish
   ```

   Set the `catan-server` meta tag first so the app finds your server. After changing the web
   app run `npm run ios:sync`.

Touch: one finger orbits, two fingers pinch-zoom and pan, a tap builds.

## Board variants

| Variant | Players | Tiles | Numbers | Harbours |
| --- | --- | --- | --- | --- |
| Classic | 2-4 | 19 | printed spiral order | 9 |
| Balanced | 2-4 | 19 | shuffled, no 6/8 or equal numbers side by side | 9 |
| 5-6 Extension | 2-6 | 30 (two deserts) | 28 tokens, balanced | 11 |

Seafarers and Cities & Knights are listed in the lobby as coming soon.

## Playing

Two to six players take turns. `src/game.js` runs the loop:

1. **Opening (snake draft).** In turn order each player places a hut and a road touching it,
   then in reverse order a second pair: 1-2-3-4-4-3-2-1, so the last player places twice in a
   row. Huts go on any free corner at least two roads from other buildings (no road needed
   yet); legal corners and edges glow for the player whose turn it is. The second hut pays
   out one card for each resource tile around it. Bots draft with their own corner values;
   if the turn clock runs out, a sensible spot is picked for you.
2. On your turn press **Roll**. Every hut (1 card) or house (2 cards) touching a
   tile with that number produces, unless the robber sits on it.
3. Click a corner to build a hut (settlement), click your own hut to upgrade it to a house (city),
   or click an edge to build a road. Costs are deducted from your hand and the distance rule
   and road-connection rules are enforced.
4. A 7 makes everyone holding more than seven cards discard half, then the current player
   clicks a tile to move the robber and steals one card from a neighbouring opponent.
5. Trade with the bank from the **Trade** sheet (*Give / for*, then *Bank*): 4:1 by default, 3:1 with a settlement
   beside a generic harbour, 2:1 for the resource of a specialised harbour. Each dock's two
   corners count as that harbour; the anchor count on a seat lists the harbours it owns.
6. Trade with players from the same sheet: choose amounts and press *Offer*.
   Bots answer immediately, humans get Accept / Decline buttons, and the first acceptance
   closes the deal. A bot's offer to a human times out after a few seconds.
7. **Cards → Buy card** (ore + wool + grain) draws from the standard 25-card development deck:
   14 knights, 5 victory points, 2 road building, 2 year of plenty, 2 monopoly. Your cards
   appear as buttons; one card per turn, never one bought this turn. A knight may be played
   before rolling. Knights move the robber and count toward largest army (3+, 2 VP, highlighted
   shield); road building gives two free roads placed by clicking edges; year of plenty and
   monopoly ask for resources with a row of buttons. Victory point cards stay hidden: the
   seats show public points until someone wins.
8. **End turn** passes play. First to 10 victory points wins (hut 1, house 2, longest
   road of 5+ segments 2, a highlighted road count; an opponent's settlement breaks a road).

### Bots

In offline games each seat has a Human / Easy / Medium / Hard selector under its name and can
be changed at any time, also mid-game. By default red is human. Bots are paced so you can
follow them: a pause when their turn starts, thinking time before each move, a beat after it
(the settings panel speeds this up or turns it off). Bot logic lives in `src/bots.js` and uses
only the same public moves a human has:

| Level | Setup | Building | Trading | Robber | Cards |
| --- | --- | --- | --- | --- | --- |
| Easy | random corner | random affordable piece, sometimes stops early | accepts on a coin flip, rarely uses the bank | random tile | buys and plays at random |
| Medium | highest dice pips | settlement > city > road, roads toward the nearest free corner | bank trades to finish its next build, accepts trades it needs | opponents' most productive tile | knight when the robber blocks it, year of plenty for missing cards, monopoly on a needed resource |
| Hard | pips weighted by resources it lacks and harbours | plans roads toward the best corner by value / distance, falls back to cheaper builds | offers 1:1 swaps first, uses its harbour ratios, refuses trades that help the leader | targets the leader, prefers players holding cards | buys when it cannot build, plays knights toward largest army, road building on the planned path, monopoly on the resource others hold most |

The full rule set of the base game is now in: building, distance and connection rules,
robber with discards and stealing, bank / harbour / player trading, development cards,
longest road, largest army and hidden victory points.

## Layout

| File | Purpose |
| --- | --- |
| `index.html`, `css/lobby.css`, `src/lobby.js` | Landing page and lobby. |
| `play.html`, `css/game.css` | Game page: seats, dock, sheets, drawer, overlays. |
| `src/main.js` | Game page setup: renderer, HDRI sky and lighting, reflective ocean, MSAA + GTAO + output passes, bounded camera with fit-to-viewport, low-power mode, offline / online game creation, move routing, settings, render loop. |
| `src/game.js` | Rules and turn flow for 2-6 players, events, log, statistics, chat, turn clock, bot pacing, online snapshots / intents / restore. |
| `src/bots.js` | Easy, medium and hard bots. |
| `src/rules.js` | Resource, cost and development card constants. |
| `src/hud.js` | Sounds and dice per game event, turn banner, chat / log / stats drawer, end-of-game summary. |
| `src/dice.js` | 3D dice toss. |
| `src/sound.js` | Synthesised sound effects. |
| `src/skins.js`, `src/catalog.js` | Piece models per skin; variant and skin catalogue (shared with the lobby). |
| `src/net.js`, `src/settings.js` | Server API and WebSocket client; saved preferences. |
| `src/avatars.js` | SVG portraits for the six seats, UI icons, dice faces. |
| `src/assets.js` | Streams the PBR texture sets, the HDRI and the water normal map; finds the sun in the HDRI; upgrades terrain sets to 2k in the background. |
| `src/materials.js` | PBR material helper, two-layer triplanar terrain splat material, wind-swayed foliage card material. |
| `src/board.js` | Board variants and layouts, terrain shuffle, number tokens (spiral or balanced) with camera-facing labels, robber, harbours, ships. |
| `src/pieces.js` | Board graph (vertices and edges from the tiles), piece placement in each player's skin, prop clearing, hover + click picking, pop-in animation. |
| `src/tiles.js` | One builder per terrain: fields, forest, pasture, hills, mountains, desert. |
| `src/hexGeometry.js` | Beveled hex base, height-mapped hex surface with skirt and blend attribute, flat hex. |
| `src/props.js` | Procedural grass / wheat / leaf card textures, card trees, textured boulders, sheep, logs, mine frames, docks, ships, scatter helper. |
| `src/textures.js` | Number token faces and harbour signs. |
| `src/noise.js` | Seeded RNG, 2D simplex noise, fbm, ridged noise, smoothstep. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable web app: offline cache, home-screen icon. |
| `../server/` | Node server: static files, accounts, lobby, rooms, relay, leaderboard. |
| `../mobile/` | Capacitor wrapper for the iOS app. |

## How a tile is built

1. A shared beveled hex slab (`hexBaseGeometry`, dark wood) is the base every tile stands on.
2. `hexSurfaceGeometry` tessellates the hexagon into ~14k triangles and evaluates
   per-terrain `height`, `color` (tint) and `blend` callbacks at each vertex, adding a
   vertical skirt so cliffs at the rim never show a gap.
3. The terrain material blends two PBR sets by the `blend` attribute (for example rock
   into grass on mountains, soil into dry grass on fields) and samples colour triplanar so
   cliff faces are not smeared.
4. Props are `InstancedMesh` scatters driven by the same height function. Grass, wheat
   and tree canopies are alpha-tested cards with procedurally painted textures that sway
   in a small vertex-shader patch; boulders are displaced spheres with a rock PBR set.
5. Forest and mountain tiles carve channels below `y = 0` and place a flat hex water plane
   at that level, which produces rivers and the mountain pool.

## Assets

Textures and HDRI are CC0 from [Poly Haven](https://polyhaven.com): aerial_grass_rock,
withered_grass, farm_soil, forest_leaves_02, rock_face, rock_boulder_dry,
red_laterite_soil_stones, aerial_sand, river_small_rocks, weathered_planks, dark_wood,
bark_willow_02 and the kloofendal_43d_clear_puresky HDRI. The water normal map is the one
shipped with the three.js examples.
