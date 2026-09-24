# Catan board in Three.js

A procedural 3D Catan board rendered with physically based materials. Tile shapes,
rivers, cliffs and props are generated at load time from noise functions; surfaces use
CC0 PBR texture sets and a sky HDRI streamed from Poly Haven. The only code dependency
is Three.js, loaded from a CDN through an import map. An internet connection is required
for the textures (about 10 MB on first load, cached by the browser afterwards).

## Run

Module scripts need an HTTP server (they will not load from `file://`).

```
cd web
python -m http.server 8080
```

Then open <http://localhost:8080/>. Any static server works (`npx serve`, VS Code Live
Server, etc.).

## URL parameters

| Parameter | Example | Effect |
| --- | --- | --- |
| `seed` | `?seed=42` | Deterministic terrain shuffle, number tokens, ports and tile details. |
| `seats` | `&seats=human,easy,medium,hard` | Who plays red, blue, white, orange. |
| `timer` | `&timer=60` | Seconds per turn; `0` turns the clock off (default 90). |
| `quality` | `&quality=low` | `low` drops the AO pass, uses smaller shadow / reflection maps and 1k textures. Touch devices get it automatically; `high` forces the full pipeline. |
| `tex` | `&tex=1k` | Skip the 2k terrain texture upgrade. |
| `cam` | `&cam=0,8,10` | Initial camera position. |
| `target` | `&target=0,0.3,0` | Initial orbit target. |
| `sw` | `&sw=0` | Do not register the service worker. |

"New board" in the ⋯ menu picks a new random seed.

## Screen layout

- **Seats** sit in the four screen corners in turn order (red top left, then clockwise).
  Each shows an avatar, the name, who plays it (Human / Easy / Medium / Hard, changeable
  at any time), the public victory points and a row of stats: resource cards, development
  cards, road length, knights and harbours. Longest road and largest army are highlighted.
- **Turn clock**: the active seat shows the remaining time as a number and as an outline
  in the player's colour that runs down around its panel, turning red for the last 10
  seconds. When time runs out the turn is finished for the player (roll, robber, pending
  card choices) and play passes on. The ⋯ menu sets 45 / 90 / 150 seconds or off; the
  clock pauses while the app is in the background.
- **Dock** (bottom centre) shows the hand of the player at the table, the dice, *Roll*,
  *Trade*, *Cards* and *End turn*. Trade and Cards open small sheets above it.
- **Messages** appear in the pill at the top.

The camera is bounded: it orbits the island, zoom stays within a range around the
distance that fits the whole board, panning keeps the centre over the island, and the
framing is recomputed on every resize or rotation so the board fits any window.

## iOS

Two ways to run it on an iPhone or iPad:

1. **Home-screen web app (no Mac needed).** Host the `web/` folder on any HTTPS static
   host (GitHub Pages, Netlify, Cloudflare Pages, ...), open it in Safari, then
   *Share → Add to Home Screen*. It launches full screen with its own icon
   (`manifest.webmanifest`, `icons/`, Apple meta tags), respects the notch / home-bar
   safe areas, and `sw.js` caches the page, three.js and the textures for fast restarts.
2. **Native app with Capacitor (needs a Mac with Xcode).** The `../mobile` folder wraps
   the same files in a native shell:

   ```
   cd mobile
   npm install
   npm run ios:add     # copies ../web into www/ and creates the Xcode project
   npm run ios:open    # opens Xcode: pick a team, then run on a device or publish
   ```

   After changing the web app run `npm run ios:sync`. The app still downloads three.js
   and the textures on first launch, so it needs a network connection.

Touch: one finger orbits, two fingers pinch-zoom and pan, a tap builds.

## Playing

Four players (red, blue, white, orange) take turns. `src/game.js` runs the loop:

1. An automatic opening placement gives each player two settlements and two roads, and the
   second settlement pays out its adjacent resources.
2. On your turn press **Roll**. Every settlement (1 card) or city (2 cards) touching a
   tile with that number produces, unless the robber sits on it.
3. Click a corner to build a settlement, click your own settlement to upgrade it to a city,
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
8. **End turn** passes play. First to 10 victory points wins (settlement 1, city 2, longest
   road of 5+ segments 2, a highlighted road count; an opponent's settlement breaks a road).

### Bots

Each seat has a Human / Easy / Medium / Hard selector under its name and can be changed
at any time, also mid-game. By default red is human and the others are easy, medium and hard.
`?seats=human,easy,medium,hard` sets red, blue, white, orange from the URL. Bot logic lives in
`src/bots.js` and uses only the same public moves a human has:

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
| `index.html` | Import map, loading overlay, corner seats, dock, sheets, iOS / PWA meta tags. |
| `src/avatars.js` | SVG portraits for the four seats, UI icons, dice faces. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable web app: offline cache, home-screen icon. |
| `src/main.js` | Renderer, HDRI sky and image based lighting, sun aligned to the HDRI, reflective ocean, MSAA + ground-truth ambient occlusion + tone-mapped output passes, bounded camera with fit-to-viewport, low-power mode, HUD wiring, render loop. |
| `src/assets.js` | Streams the PBR texture sets, the HDRI and the water normal map; finds the sun in the HDRI; upgrades terrain sets to 2k in the background (`?tex=1k` disables). |
| `src/materials.js` | PBR material helper, two-layer triplanar terrain splat material, wind-swayed foliage card material. |
| `src/board.js` | 19-hex layout, terrain shuffle, spiral number tokens with camera-facing labels, robber, harbours with 3:1 / 2:1 signs, ships that loop around the island. |
| `src/pieces.js` | Board graph (54 vertices, 72 edges); settlement (cottage with chimney and lit windows), city (hall and spired tower) and road models; hover + click placement and pop-in animation. |
| `src/tiles.js` | One builder per terrain: fields, forest, pasture, hills, mountains, desert. |
| `src/hexGeometry.js` | Beveled hex base, height-mapped hex surface with skirt and blend attribute, flat hex. |
| `src/props.js` | Procedural grass / wheat / leaf card textures, card trees, textured boulders, sheep, logs, mine frames, docks, ships, scatter helper. |
| `src/textures.js` | Number token faces (and legacy generators). |
| `src/noise.js` | Seeded RNG, 2D simplex noise, fbm, ridged noise, smoothstep. |

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
