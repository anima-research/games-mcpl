# The autosave must not move the world. The server saves after every turn, and saving
# takes engine tics; those tics used to run the game, so on Nightmare a player standing
# still between turns could be hit or killed, and the next game_act only said
# "Episode is over". Checks, against the real engine:
#   - a save leaves the clock, the player and every object exactly where they were;
#   - each turn advances the clock by exactly its own tics (the unpause costs none);
#   - a second save in a row, a restart and a resume all leave the game running.
#   py/.venv/bin/python -I test/autosave.py
import os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "py"))
os.chdir(tempfile.mkdtemp(prefix="games-autosave-"))  # save files land in the engine's cwd

import sidecar  # noqa: E402
import vizdoom as vzd  # noqa: E402

GV = vzd.GameVariable


def world(d):
    g = d.g
    objs = tuple(sorted((o.id, o.name, round(o.position_x, 3), round(o.position_y, 3), round(o.angle, 2)) for o in g.get_state().objects))
    return {"time": g.get_episode_time(), "health": g.get_game_variable(GV.HEALTH),
            "damage_taken": g.get_game_variable(GV.DAMAGE_TAKEN), "objects": objs}


def act(d, actions):
    t = d.g.get_episode_time()
    obs = d.act(actions, stop_on=[], image="none")
    return obs, (d.g.get_episode_time() if not d.finished() else None), t


def check_save_frozen(d, label):
    w0 = world(d)
    r = d.save()
    assert r["saved"], f"{label}: save failed: {r}"
    w1 = world(d)
    assert w1 == w0, f"{label}: the world moved during the save: time {w0['time']}->{w1['time']}, health {w0['health']}->{w1['health']}, objects moved: {w0['objects'] != w1['objects']}"


d = sidecar.Doom()
d.start(game="freedoom1", map="E1M1", skill=5, image="none")

# wake the level: fire, walk in
act(d, [{"attack": 3}, {"move": "forward", "tics": 30}])
w0 = world(d); d.g.make_action([0] * len(sidecar.BUTTONS), 2)
assert world(d)["objects"] != w0["objects"], "precondition: monsters should be awake and moving"

# turns with an autosave between each, standing still on Nightmare
died = None
for turn in range(40):
    check_save_frozen(d, f"turn {turn}")
    obs, after, before = act(d, [{"wait": 20}])
    if obs["dead"]:
        died = obs
        break
    assert after - before == 20, f"turn {turn}: 20 tics asked, the clock moved {after - before}"
if died:
    assert any("YOU DIED" in e for e in died["events"]), f"death not reported by the turn it happened in: {died['events']}"
    print(f"died on turn {turn}, reported by that turn: ok")
    d.start(game="freedoom1", map="E1M1", skill=5, image="none")

# two saves in a row, then a turn
check_save_frozen(d, "first of two")
check_save_frozen(d, "second of two")
obs, after, before = act(d, [{"wait": 7}])
assert after - before == 7, f"after two saves: 7 tics asked, the clock moved {after - before}"

# restart the map straight after a save: the new episode runs
d.save()
d.start(game="freedoom1", map="E1M1", skill=5, image="none")
obs, after, before = act(d, [{"wait": 5}])
assert after - before == 5, f"restart after a save: 5 tics asked, the clock moved {after - before}"

# resume a save made while paused in a fresh engine: it runs
d.save()
d.close()
d2 = sidecar.Doom()
d2.start(game="freedoom1", map="E1M1", skill=5, image="none", load="autosave")
obs, after, before = act(d2, [{"wait": 5}])
assert after - before == 5, f"resumed: 5 tics asked, the clock moved {after - before}"
check_save_frozen(d2, "after resume")
d2.close()
print("autosave: ok")
