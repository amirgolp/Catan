# Catan

A 3D Catan game built with Three.js: a procedural island with PBR materials, bots at three
levels, online rooms for 2-6 players, a leaderboard and collectible piece skins. Runs in the
browser and on iPhone / iPad.

| Folder | Contents |
| --- | --- |
| [`web/`](web/) | The game and the lobby (plain ES modules, no build step). Full documentation in [`web/README.md`](web/README.md). |
| [`server/`](server/) | Node server: serves `web/`, accounts, lobby, rooms, chat relay, leaderboard. |
| [`mobile/`](mobile/) | Capacitor wrapper that builds the iOS app from `web/`. |

The Unreal Engine project files at the top level (`Catan.uproject`, `Config/`, `Content/`) are
an earlier prototype and are not needed to run the game.

## Quick start

```
cd server
npm install
npm start
```

Open <http://localhost:8080/>, sign up or play as a guest, then play against bots or create a
room and share its code. For offline play only, any static server in `web/` works
(`python -m http.server 8080`).
