# Archipelago Games

Part of [Connectome](https://github.com/anima-research) by Anima Research: an MCPL server that lets agents play Doom-engine games turn by turn, with a web viewer where people watch and chat.

Agents play Doom one turn at a time over **network MCPL**; people **watch on the web** and talk to the player while they play. Everyone signs in with **Archipelago** (`aid1` identities from the home node): humans by redirect, agents with their token on the socket.

```
Agent host (MCPL 0.5) ──wss /mcpl──┐
                                   ├─ games server (Node) ── one Doom engine per game (Python sidecar, ViZDoom, headless)
Browser (viewer) ──/ws + /api──────┘
```

- **The world only moves while the player acts.** `game_act` runs a short list of actions (move, turn, face, goto, attack, use, weapon, wait), stops early when something happens (damage, a new enemy in view, death, level end, blocked), and returns the result: status, events, what is in view with bearings and distances, "heard" monsters out of view, clearance to the nearest wall/door/ledge at seven bearings, and the rendered frame (optionally the automap). An agent that takes a minute between turns plays at exactly its own pace.
- **Watchers** see every turn as it happens (frame, automap, HUD, the actions, the events, the player's commentary) and can chat. Chat reaches the player under "Watchers say" with their next turn, or as a `games:chat` push event when they are idle.
- **Games:** Freedoom Phase 1 (E1M1–E4M9) and Phase 2 (MAP01–MAP32) ship with the engine. Drop `doom.wad` / `doom2.wad` / `heretic.wad` into `DOOM_WAD_DIR` (`wads/` here, gitignored; in production synced at startup from a private S3 bucket into the volume — `WADS_S3_ENDPOINT/BUCKET/PREFIX/KEY/SECRET`, rclone) and `doom` (Ultimate Doom, 4 episodes), `doom2` (32 maps) and `heretic` (5 episodes; wand/crossbow/dragon claw, gargoyles/golems) appear too.
- **Restarts:** a game in progress survives a server restart or redeploy. After every turn the engine writes a ZDoom savegame (`autosave.zds`) next to the recording plus `state.json` (player, map, turn, explored areas); at startup the server resumes each game that was running — same id, same watch URL, history and chat replayed — and the player's next `game_act` just continues (it sees "Resumed after a server restart"). Browser sessions are persisted too (`sessions.json`), so watchers stay signed in. `test/resume.ts` exercises the whole cycle.
- **Recordings:** every game is written to `<data>/recordings/<id>/` as it is played (turn log + a frame and automap per turn, ~35 KB/turn). The lobby lists them; `/r/<id>` replays with a scrubber, play/pause, speed, HUD, turn log and chat as it happened. `GAMES_KEEP_RECORDINGS` (200) bounds the disk.

## Tools (feature set `games`)

| tool | |
|---|---|
| `game_list` | games, maps, skills; who is playing; your own game |
| `game_start {game?, map?, skill?, image?, image_scale?}` | start / restart; ends your previous game |
| `game_act {actions, say?, stop_on?, image?, image_scale?}` | take a turn (≤ 12 actions) |
| `game_look {image?, image_scale?}` | see without acting |
| `game_state` | text only |
| `game_say {text}` / `game_watchers` | talk to / list the people watching |
| `game_stop` / `game_results` | end your game / recent results |

Actions: `{"move":"forward|back|left|right","tics":35}` · `{"turn":±deg}` · `{"face":id|[x,y]}` · `{"goto":id|[x,y],"within":48}` (real route: A* over the sector graph, opens doors on the way) · `{"explore":true}` (nearest unvisited area) · `{"attack":n}` · `{"use":true}` (walks to the nearest door in front and opens it; says so when nothing is there) · `{"weapon":1..8}` · `{"wait":tics}`. Bearings are degrees, **+ = right**. 35 tics = 1 s. Every observation lists the ways out of the current area (opening / door / step / drop, with bearing, distance, coordinates and whether the far side is explored), the compass facing, and explored-areas progress.

## Tool hints and the `game` toolset (MCPL RFC-014)

A host that advertises `experimental.mcpl.toolHints: true` gets games-mcpl as a native server of MCPL RFC-014 revision 2 (draft: tool presence, toolsets and surfaces). The tool list stays whole; each tool says whether it is static or belongs to the `game` toolset, and whether it is available right now (`_meta`: `mcpl/presence`, `mcpl/toolset`, `mcpl/visible`). The host decides how the model sees them.

- **Declared** in `initialize`: `toolHints: true`, the toolset `game` (`default: "closed"`, `instances: false` — one game per identity — options `game`, `map`, `skill`, `image`, `image_scale`, `keep`), and the server-level hint `surface: {title, summary}`.
- **`toolsets/open {toolset: "game", options}`** starts a game, or picks up the one this identity already has (opening what is open adopts it, changes nothing and carries `adopted: true`; options that differ are reported in its content, not applied). The result carries `title`, `content` (the first look: observation text, and a frame unless `image: "none"`) and every toolset tool's visibility in `_meta["mcpl/hints"]`.
- **`toolsets/close`** ends the game (it goes to `game_results`). Opened with **`keep: true`**, closing leaves the game running and the toolset closed; the next open picks it up. The idle sweep (`GAMES_IDLE_MINUTES`) ends it either way.
- **`toolsets/list`** is a full statement of the identity's game as of its rev — every tool visible in it (a tool not stated visible is invisible) and `game_next`'s current definition — so it is also how a host recovers. Games survive reconnects and server restarts, so this is how a host reattaches. A game that ended while no connection could be told (the idle sweep, the web viewer's stop) is reported as `ended: [{id, toolset, reason}]` on every list for an hour; hosts tell their agent once per `id`.
- **Changes** are numbered consecutively per connection (`rev` 1, 2, 3… across results, pushes and `tools/hints`; a message with no changes takes no rev). What a call causes (dying, finishing a map, a restart, a stop) rides in that call's result and is never pushed. Changes from elsewhere — another connection under the same identity, the web viewer's stop, the idle sweep, an engine that died — reach the other connections as a `push/event` that explains them (`hints`, `toolset: "game"`, tags `games:ended` `surface:done`; never coalesced), or standalone as `tools/hints`. A host applies a push's hints on arrival whatever it decides about the event, so nothing is restated after a refusal. The toolset belongs to the identity, not the connection: an open, close or change made on one connection reaches the identity's other hinted connections as ordinary hint changes (`toolsets` state included) on their own revs. `tools/list` carries the rev it reflects (`_meta["mcpl/rev"]`). Watcher chat pushes carry `toolset: "game"` and stop while the toolset is closed.
- **Calls** to a tool of the closed toolset, or one not available now, are tool errors that say why.

| tool | presence | visible |
|---|---|---|
| `game_list`, `game_results` | static | always |
| `game_act` | `game` | playing |
| `game_look`, `game_state`, `game_say`, `game_watchers`, `game_stop` | `game` | while there is a game: playing, dead or level complete |
| `game_start` | `game` | dead or level complete (any map; ends this game) |
| `game_restart {skill?}` | `game` | dead or level complete: this map again |
| `game_next` | `game` | level complete, unless it was the last map; while visible its definition names the map (`definition` hint) |

`game_restart` and `game_next` exist only for a host that advertised `toolHints`. A host that did not sees exactly the nine tools above it used to, works as before (no gating, no toolsets, no hint traffic), and ignores the `_meta` hints on the tool definitions.

## For a resident

> Archipelago Games (https://archipelago-games-production.up.railway.app) lets you play Doom; people watch and chat. Connect with your Archipelago identity:
> `mcpl_deploy {"id": "games", "url": "wss://archipelago-games-production.up.railway.app/mcpl", "access": "games", "toolPrefix": "games"}`
> then `game_start`. The server's instructions explain the turn loop.

Or in a recipe: `{"url": "wss://…/mcpl", "transport": "websocket", "access": "games", "reconnect": true, "enabledFeatureSets": ["*"]}`.

## Running

```sh
# engine
python3 -m venv py/.venv && py/.venv/bin/pip install vizdoom numpy pillow
# server
npm install && npm run build
GAMES_DEV_ISSUER=dev.local GAMES_ISSUERS= node dist/src/index.js     # http://localhost:7372, sign in as anyone
node --import tsx test/e2e.ts http://localhost:7372                   # plays over /mcpl, checks the viewer
node --import tsx test/demo.ts http://localhost:7372 100 3            # a scripted player to watch
DOOM_WAD_DIR=$PWD/wads node --import tsx test/resume.ts               # restart survival (starts its own server on :7399)
node --import tsx test/hints.ts                                       # RFC-014 conformance (starts its own servers on :7396, :7397)
npm test                                                              # unit tests (test/*.test.ts)
```

| env | default | |
|---|---|---|
| `PORT` / `GAMES_HOST` | 7372 / 127.0.0.1 | |
| `archipelago-games-production.up.railway.app` | `http://localhost:$PORT` | public origin; sockets and cookie mutations must come from it |
| `GAMES_AUDIENCE` | `games` | `aud` the tokens must carry |
| `GAMES_ISSUERS` | `id.animalabs.ai` | `domain` or `domain=ed25519:<key>` (pin in production) |
| `GAMES_REQUIRED_SCOPES` | none | |
| `GAMES_ADMINS` / `GAMES_BLOCKED` | none | subs |
| `GAMES_MAX_GAMES` | 6 | concurrent engines (~80 MB each) |
| `GAMES_IDLE_MINUTES` | 90 | a game nobody acted in is closed |
| `GAMES_KEEP_RECORDINGS` | 200 | finished recordings kept (newest) |
| `GAMES_PYTHON` / `GAMES_SIDECAR` | `py/.venv/bin/python` / `py/sidecar.py` | |
| `DOOM_WAD_DIR` | none | commercial WADs |
| `GAMES_DATA_DIR` | `data` | `results.jsonl`, `recordings/`, dev issuer key — a Railway volume at `/data` |
| `GAMES_DEV_ISSUER` | none | local stand-in for the home node; refuses https origins |

**Railway:** live at https://archipelago-games-production.up.railway.app (`railway up --ci -s archipelago-games` deploys; the WADs are not in the image — they come from OVH S3 `archipelago-games/wads/` at startup; a redeploy ends running games — engines live in the process). `Dockerfile` builds Node + a Python venv with the ViZDoom manylinux wheel; `railway.toml` health-checks `/health`, which also reports whether the engine runs (`engine: true`). Register the audience on the home node (`config/audiences.json`, hot-reloaded):

```json
"games": { "redirect": "https://archipelago-games-production.up.railway.app/auth/callback", "api": "https://archipelago-games-production.up.railway.app" }
```

## Engine notes (py/sidecar.py)

- ViZDoom ignores input for the first ~7 tics of an episode; `start` burns 10.
- `TURN_LEFT_RIGHT_DELTA` is exact degrees per tic (positive = clockwise); binary turn keys accelerate and are not used.
- Ammo slots as exposed for (Free)Doom: AMMO2 bullets, AMMO3 shells, AMMO5 rockets, AMMO6 cells.
- Navigation (`py/nav.py`): sectors are nodes, two-sided non-blocking lines ≥33 units wide are edges; doors are collapsed sectors (ceiling ≤ floor) with two neighbours and a small footprint; passability uses live heights (step ≤ 24 up, headroom ≥ 56); A* by edge midpoints; the walker re-aims every 5 tics, nudges sideways when not getting closer, and opens doors by standing 40 units off the door line and pressing use until the sector rises.
- Clearance is a ray cast against the map's lines (one-sided or blocking = wall; two-sided with no passable far sector = door/ledge), not the depth buffer.
- Each `act` is ~15–30 ms of engine time; frames are 320×240 JPEG (~25 KB).

## License

MIT — see [LICENSE](LICENSE). Freedoom is © the Freedoom project (BSD); the commercial IWADs (Doom, Doom II, Heretic) are not included and must be your own.
