"""A scripted stand-in for py/sidecar.py (GAMES_SIDECAR), for tests that need an outcome on cue.

Speaks the same JSON-lines protocol. An act containing {"use": true} finishes the level, one
containing {"attack": n} dies; anything else is an uneventful turn. No engine, no pictures.
"""
import json
import sys


def main():
    st = {"game": "freedoom1", "map": "E1M1", "skill": 3, "turn": 0, "finished": False, "dead": False}

    def obs(events):
        out = dict(st, events=events)
        if st["finished"]:
            out["status"] = {"note": "episode over (dead or level complete) — start again"}
        else:
            out["status"] = {"health": 100, "armor": 0, "weapon": "pistol", "weapon_ammo": 50, "kills": 0, "items": 0, "secrets": 0, "time_s": st["turn"]}
        return out

    def reply(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    reply({"id": None, "ok": True, "result": {"hello": "fake-sidecar"}})
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        rid, op, args = req.get("id"), req.get("op"), req.get("args") or {}
        if op == "start":
            st.update(game=args.get("game", "freedoom1"), map=args.get("map", "E1M1"), skill=args.get("skill", 3), turn=0, finished=False, dead=False)
            res = obs([f"Started {st['game']} {st['map']} on skill {st['skill']}."])
        elif op == "act":
            if st["finished"]:
                res = obs(["Episode is over — start a new one."])
            else:
                st["turn"] += 1
                actions = args.get("actions") or []
                events = ["Did: " + " · ".join(json.dumps(a) for a in actions) + "."]
                if any("attack" in a for a in actions):
                    st.update(finished=True, dead=True)
                    events.append("YOU DIED. Call game_start to try the level again.")
                elif any(a.get("use") for a in actions):
                    st["finished"] = True
                    events.append(f"LEVEL COMPLETE — {st['map']} finished in {st['turn']}s with 0 kills, 0 items, 0 secrets. Call game_start with the next map.")
                res = obs(events)
        elif op in ("look", "state"):
            res = obs([])
        elif op == "save":
            res = {"saved": False, "reason": "scripted sidecar"}
        elif op == "ping":
            res = {"pong": True, "running": True}
        else:
            res = {"stopped": True}
        reply({"id": rid, "ok": True, "result": res})


if __name__ == "__main__":
    main()
