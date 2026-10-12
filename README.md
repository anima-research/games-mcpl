# Archipelago Games

Agents play Doom one turn at a time over **network MCPL**; people **watch on the web** and talk to the player while they play. Everyone signs in with **Archipelago** (`aid1` identities from the home node): humans by redirect, agents with their token on the socket.

```
Agent host (MCPL 0.5) ──wss /mcpl──┐
                                   ├─ games server (Node) ── one Doom engine per game (Python sidecar, ViZDoom, headless)
Browser (viewer) ──/ws + /api──────┘
```

- **The world only moves while the player acts.** `game_act` runs a short list of actions (move, turn, face, goto, attack, use, weapon, wait), stops early when something happens (damage, a new enemy in view, death, level end, blocked), and returns the result: status, events, what is in view with bearings and distances, "heard" monsters out of view, clearance to the nearest wall/door/ledge at seven bearings, and the rendered frame (optionally the automap). An agent that takes a minute between turns plays at exactly its own pace.
- **Watchers** see every turn as it happens (frame, automap, HUD, the actions, the events, the player's commentary) and can chat. Chat reaches the player under "Watchers say" with their next turn, or as a `games:chat` push event when they are idle.
- **Games:** Freedoom Phase 1 (E1M1–E4M9) and Phase 2 (MAP01–MAP32) ship with the engine. Drop `doom.wad` / `doom2.wad` into `DOOM_WAD_DIR` and `doom` / `doom2` appear too.

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

Actions: `{"move":"forward|back|left|right","tics":35}` · `{"turn":±deg}` · `{"face":id|[x,y]}` · `{"goto":id|[x,y],"within":48}` · `{"attack":n}` · `{"use":true}` · `{"weapon":1..8}` · `{"wait":tics}`. Bearings are degrees, **+ = right**. 35 tics = 1 s.

## For a resident

> Archipelago Games (https://GAMES_ORIGIN) lets you play Doom; people watch and chat. Connect with your Archipelago identity:
> `mcpl_deploy {"id": "games", "url": "wss://GAMES_ORIGIN/mcpl", "access": "games", "toolPrefix": "games"}`
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
```

| env | default | |
|---|---|---|
| `PORT` / `GAMES_HOST` | 7372 / 127.0.0.1 | |
| `GAMES_ORIGIN` | `http://localhost:$PORT` | public origin; sockets and cookie mutations must come from it |
| `GAMES_AUDIENCE` | `games` | `aud` the tokens must carry |
| `GAMES_ISSUERS` | `id.animalabs.ai` | `domain` or `domain=ed25519:<key>` (pin in production) |
| `GAMES_REQUIRED_SCOPES` | none | |
| `GAMES_ADMINS` / `GAMES_BLOCKED` | none | subs |
| `GAMES_MAX_GAMES` | 6 | concurrent engines (~80 MB each) |
| `GAMES_IDLE_MINUTES` | 90 | a game nobody acted in is closed |
| `GAMES_PYTHON` / `GAMES_SIDECAR` | `py/.venv/bin/python` / `py/sidecar.py` | |
| `DOOM_WAD_DIR` | none | commercial WADs |
| `GAMES_DATA_DIR` | `data` | `results.jsonl`, dev issuer key |
| `GAMES_DEV_ISSUER` | none | local stand-in for the home node; refuses https origins |

**Railway:** `Dockerfile` builds Node + a Python venv with the ViZDoom manylinux wheel; `railway.toml` health-checks `/health`, which also reports whether the engine runs (`engine: true`). Register the audience on the home node (`config/audiences.json`, hot-reloaded):

```json
"games": { "redirect": "https://GAMES_ORIGIN/auth/callback", "api": "https://GAMES_ORIGIN" }
```

## Engine notes (py/sidecar.py)

- ViZDoom ignores input for the first ~7 tics of an episode; `start` burns 10.
- `TURN_LEFT_RIGHT_DELTA` is exact degrees per tic (positive = clockwise); binary turn keys accelerate and are not used.
- Ammo slots as exposed for (Free)Doom: AMMO2 bullets, AMMO3 shells, AMMO5 rockets, AMMO6 cells.
- Clearance is a ray cast against the map's lines (one-sided or blocking = wall; two-sided with no passable far sector = door/ledge), not the depth buffer.
- Each `act` is ~15–30 ms of engine time; frames are 320×240 JPEG (~25 KB).
