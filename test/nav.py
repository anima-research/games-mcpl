# The route planner's map must match the level. Two things it got wrong on Doom E1M1, which
# left a player unable to reach the exit with explore/goto:
#   - a sector with lines that have the same sector on both sides (the last room has six) was
#     filled inside out, so the room was a hole in the map and nothing behind it was reachable;
#   - a door set back in a recess too shallow to stand in was not found by `use`, nor listed
#     under openings, because it does not border the area the player stands in.
# And one thing it never told: where a room's switches are. The exit switch of E1M1 is on a
# side wall of the exit room; the player is now told, and `use` walks up to it.
# The first part needs no engine. The second plays the last stretch of E1M1 and is skipped
# when doom.wad is not there (DOOM_WAD_DIR, default ./wads).
#   py/.venv/bin/python -I test/nav.py
import os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "py"))
os.environ.setdefault("DOOM_WAD_DIR", os.path.join(HERE, "..", "wads"))

from nav import NavMap, _key  # noqa: E402


class Line:
    def __init__(self, x1, y1, x2, y2, blocking):
        self.x1, self.y1, self.x2, self.y2, self.is_blocking = float(x1), float(y1), float(x2), float(y2), blocking


class Sector:
    def __init__(self, lines, floor=0.0, ceiling=128.0):
        self.lines, self.floor_height, self.ceiling_height = lines, floor, ceiling


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        sys.exit(1)


# ── a 320×192 room with two impassable inner lines 32 units in from its short sides ──
outline = [Line(0, 0, 320, 0, True), Line(320, 0, 320, 192, True), Line(320, 192, 0, 192, True), Line(0, 192, 0, 0, True)]
inner = [Line(32, 0, 32, 192, True), Line(288, 192, 288, 0, True)]
room = [Sector(outline + inner)]
middle = (160, 96)
wrong = NavMap(room)
check(wrong.cell_sector[wrong.cell(*middle)] == -1, "told nothing, the fill takes the inner lines for outline (the old behaviour)")
right = NavMap(room, {_key(ln) for ln in inner})
check(right.cell_sector[right.cell(*middle)] == 0, "told which lines are inner, the middle of the room is in the room")
check(right.walkable(right.cell(*middle), room), "…and walkable")
check(not right.walkable(right.cell(40, 96), room), "an impassable inner line is still a wall")

# ── the real thing ──
import sidecar  # noqa: E402

if "doom" not in sidecar.GAMES:
    print("skip the E1M1 part: no doom.wad in", os.environ["DOOM_WAD_DIR"])
    sys.exit(0)
os.chdir(tempfile.mkdtemp(prefix="games-nav-"))
d = sidecar.Doom()
d.start(game="doom", map="E1M1", skill=1, image="none")
s = d.g.get_state()
LAST_ROOM, EXIT_ROOM, HALL, RECESS_DOOR = 72, 82, 56, 76
check(any(c == LAST_ROOM and not d.nav.wall[i] for i, c in enumerate(d.nav.cell_sector)), "E1M1: the last room is on the map")
check(d.nav.path_cells(3008, -3900, 3008, -4760, s.sectors) is not None, "E1M1: there is a route from the hall to the exit room")
check(any(e.b == RECESS_DOOR for e in d.nav.door_edges(HALL)), "E1M1: the door in the recess counts as a door of the hall")
check(any(o["kind"].startswith("door") and o["sector"] == RECESS_DOOR for o in d.nav.openings(HALL, 3008, -3900, s.sectors, set())),
      "E1M1: …and is listed among the hall's openings")

# play it: put the player in the hall, away from the door, and let explore find the exit room
d.g.send_game_command("god")
d.g.send_game_command("warp 3008 -3800")
d._tic(d._press(), 3)
d.visited = set(range(d.nav.n)) - {LAST_ROOM, 73, 74, 78, 79, 80, 84, EXIT_ROOM, 83}
obs = d.act([{"goto": [2990, -3960]}], stop_on=[], image="none")
obs = d.act([{"face": [3008, -4024]}, {"turn": 35}, {"use": True}], stop_on=[], image="none")
check(any("door opened" in e for e in obs["events"]), "E1M1: `use` at an angle to the recessed door opens it — " + " | ".join(obs["events"]) + f" at {obs['position']}")
for turn in range(10):
    if EXIT_ROOM in d.visited:
        break
    obs = d.act([{"explore": True}], stop_on=["dead"], image="none")
check(EXIT_ROOM in d.visited, f"E1M1: explore reaches the exit room ({turn} turns)")
obs = d.act([{"goto": [3008, -4700]}], stop_on=[], image="none")
sw = obs.get("switches") or []
check(len(sw) == 1 and sw[0]["kind"] == "exit switch" and (sw[0]["x"], sw[0]["y"]) == (2912, -4768), f"E1M1: the exit room lists its exit switch — {sw}")
obs = d.act([{"turn": sw[0]["bearing"] + 40}, {"use": True}], stop_on=["level"], image="none")
check(obs["finished"], "E1M1: `use`, roughly facing the exit switch, walks up to it and ends the level — " + obs["events"][0])
d.close()
print("all good")
