#!/usr/bin/env python3
"""
Doom sidecar for games-mcpl.

Wraps ViZDoom (headless) behind a JSON-lines protocol on stdin/stdout so the
Node MCPL server can drive the game one *turn* at a time: the world only
advances while an `act` request is being executed, so an agent that takes
seconds between moves plays at exactly its own pace.

Request:  {"id": n, "op": "start"|"act"|"look"|"state"|"games"|"stop", "args": {...}}
Response: {"id": n, "ok": true, "result": {...}} | {"id": n, "ok": false, "error": "..."}

Every observation carries: status (health/armor/weapons/ammo), position,
what is in view (labels with bearing + distance), what is nearby but out of
view ("heard"), wall clearance by bearing (ray-cast against the map's blocking
lines), the events that happened during the last act, and optionally the
rendered frame / automap as JPEG base64.
"""
import base64
import io
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nav import NavMap, compass  # noqa: E402

try:
    import vizdoom as vzd
    from PIL import Image
except Exception as e:  # pragma: no cover
    sys.stdout.write(json.dumps({"id": None, "ok": False, "error": f"import failed: {e}"}) + "\n")
    sys.stdout.flush()
    sys.exit(1)

VZD_DIR = os.path.dirname(vzd.__file__)
WAD_DIR = os.environ.get("DOOM_WAD_DIR", "")

# ───────────────────────── game catalogue ─────────────────────────

GAMES = {
    "freedoom1": {"wad": os.path.join(VZD_DIR, "freedoom1.wad"), "maps": [f"E{e}M{m}" for e in range(1, 5) for m in range(1, 10)],
                  "title": "Freedoom: Phase 1 (free Doom-compatible campaign, 4 episodes × 9 maps)"},
    "freedoom2": {"wad": os.path.join(VZD_DIR, "freedoom2.wad"), "maps": [f"MAP{m:02d}" for m in range(1, 33)],
                  "title": "Freedoom: Phase 2 (free Doom II-compatible campaign, 32 maps)"},
}
for name, maps, title in (("doom", [f"E{e}M{m}" for e in range(1, 5) for m in range(1, 10)], "The Ultimate DOOM (1993/95, 4 episodes × 9 maps)"),
                          ("doom2", [f"MAP{m:02d}" for m in range(1, 33)], "DOOM II: Hell on Earth (32 maps)"),
                          ("heretic", [f"E{e}M{m}" for e in range(1, 6) for m in range(1, 10)], "Heretic: Shadow of the Serpent Riders (5 episodes × 9 maps; wand, crossbow, dragon claw…)")):
    p = os.path.join(WAD_DIR, f"{name}.wad") if WAD_DIR else ""
    if p and os.path.exists(p):
        GAMES[name] = {"wad": p, "maps": maps, "title": title}

SKILLS = {1: "I'm too young to die", 2: "Hey, not too rough", 3: "Hurt me plenty", 4: "Ultra-Violence", 5: "Nightmare!"}

WEAPON_NAMES = {1: "fist", 2: "pistol", 3: "shotgun", 4: "chaingun", 5: "rocket launcher", 6: "plasma rifle", 7: "BFG9000", 8: "chainsaw"}
HERETIC_WEAPONS = {1: "staff", 2: "elven wand", 3: "ethereal crossbow", 4: "dragon claw", 5: "hellstaff", 6: "phoenix rod", 7: "firemace", 8: "gauntlets of the necromancer"}
HERETIC_AMMO = {2: "wand crystals", 3: "ethereal arrows", 4: "claw orbs", 5: "hellstaff runes", 6: "flame orbs", 7: "mace spheres"}
# Ammo slots as ViZDoom exposes them for (Free)Doom — measured with `give all` and weapon
# switches: AMMO2 bullets (max 400), AMMO3 shells (100), AMMO5 rockets (100), AMMO6 cells
# (600); AMMO4/AMMO7 mirror bullets/cells (parent ammo classes).
AMMO_SLOTS = {2: "bullets", 3: "shells", 5: "rockets", 6: "cells"}

MONSTER_NAMES = {
    "Zombieman": "zombie (rifle)", "ShotgunGuy": "shotgun zombie", "ChaingunGuy": "chaingunner", "DoomImp": "imp",
    "Demon": "pinky demon", "Spectre": "spectre (invisible demon)", "LostSoul": "lost soul", "Cacodemon": "cacodemon",
    "HellKnight": "hell knight", "BaronOfHell": "baron of hell", "Arachnotron": "arachnotron", "PainElemental": "pain elemental",
    "Revenant": "revenant", "Fatso": "mancubus", "Archvile": "arch-vile", "SpiderMastermind": "spider mastermind", "Cyberdemon": "cyberdemon",
    "WolfensteinSS": "SS trooper",
    # Heretic
    "HereticImp": "gargoyle", "HereticImpLeader": "fire gargoyle", "Mummy": "golem", "MummyLeader": "nitrogolem", "MummyGhost": "golem ghost",
    "MummyLeaderGhost": "nitrogolem ghost", "Knight": "undead warrior", "KnightGhost": "undead warrior ghost", "Wizard": "disciple of D'Sparil",
    "Beast": "weredragon", "Snake": "ophidian", "Clink": "sabreclaw", "Ironlich": "iron lich", "Minotaur": "maulotaur", "Sorcerer1": "D'Sparil (on serpent)", "Sorcerer2": "D'Sparil",
}
INTERESTING = {"Monster", "Health", "Armor", "Ammo", "Weapon", "Key", "Powerup", "Hazard", "Artifact"}

FOV = 90.0
TICS_PER_SEC = 35
MAX_TURN_PER_TIC = 30.0

BUTTONS = [vzd.Button.MOVE_FORWARD, vzd.Button.MOVE_BACKWARD, vzd.Button.MOVE_LEFT, vzd.Button.MOVE_RIGHT,
           vzd.Button.TURN_LEFT_RIGHT_DELTA, vzd.Button.ATTACK, vzd.Button.USE, vzd.Button.SPEED,
           vzd.Button.SELECT_WEAPON1, vzd.Button.SELECT_WEAPON2, vzd.Button.SELECT_WEAPON3, vzd.Button.SELECT_WEAPON4,
           vzd.Button.SELECT_WEAPON5, vzd.Button.SELECT_WEAPON6, vzd.Button.SELECT_WEAPON7, vzd.Button.SELECT_WEAPON8]
BI = {b: i for i, b in enumerate(BUTTONS)}
GV = [vzd.GameVariable.HEALTH, vzd.GameVariable.ARMOR, vzd.GameVariable.SELECTED_WEAPON, vzd.GameVariable.SELECTED_WEAPON_AMMO,
      vzd.GameVariable.POSITION_X, vzd.GameVariable.POSITION_Y, vzd.GameVariable.POSITION_Z, vzd.GameVariable.ANGLE,
      vzd.GameVariable.KILLCOUNT, vzd.GameVariable.ITEMCOUNT, vzd.GameVariable.SECRETCOUNT, vzd.GameVariable.HITCOUNT,
      vzd.GameVariable.DAMAGECOUNT, vzd.GameVariable.DAMAGE_TAKEN, vzd.GameVariable.DEAD, vzd.GameVariable.ATTACK_READY,
      vzd.GameVariable.AMMO2, vzd.GameVariable.AMMO3, vzd.GameVariable.AMMO5, vzd.GameVariable.AMMO6,
      vzd.GameVariable.WEAPON1, vzd.GameVariable.WEAPON2, vzd.GameVariable.WEAPON3, vzd.GameVariable.WEAPON4,
      vzd.GameVariable.WEAPON5, vzd.GameVariable.WEAPON6, vzd.GameVariable.WEAPON7, vzd.GameVariable.WEAPON8]
GI = {g: i for i, g in enumerate(GV)}


def log(*a):
    sys.stderr.write("[doom-sidecar] " + " ".join(str(x) for x in a) + "\n")
    sys.stderr.flush()


def ang_norm(a):
    return (a + 180.0) % 360.0 - 180.0


def jpeg_b64(arr, quality=80, scale=1.0):
    im = Image.fromarray(arr)
    if scale != 1.0:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ───────────────────────── the engine wrapper ─────────────────────────

class Doom:
    def __init__(self):
        self.g = None
        self.game = None
        self.map = None
        self.skill = 3
        self.res = (320, 240)
        self.started_at = None
        self.turns = 0
        self.last_frame = None      # numpy RGB
        self.last_automap = None
        self.seen_monsters = set()  # object ids ever seen in view this episode
        self.frames_dir = os.environ.get("DOOM_FRAMES_DIR", "")
        self.action_log = []
        self.notes = []       # HUD messages seen during the current act
        self.nav = None       # NavMap for the current episode
        self.visited = set()  # sector ids the player has stood in
        self.gave_up = {}     # sector id -> failed explore attempts (2 = skip it)

    # ── lifecycle ──
    def start(self, game="freedoom1", map=None, skill=3, width=320, height=240, image="frame", image_scale=1.0):
        if game not in GAMES:
            raise ValueError(f"unknown game {game!r}; available: {', '.join(GAMES)}")
        maps = GAMES[game]["maps"]
        map = (map or maps[0]).upper()
        if map not in maps:
            raise ValueError(f"unknown map {map!r} for {game}; maps: {maps[0]}…{maps[-1]}")
        skill = int(skill)
        if skill not in SKILLS:
            raise ValueError("skill must be 1..5")
        res = (int(width), int(height))
        reinit = self.g is None or self.game != game or self.skill != skill or self.res != res
        if reinit:
            self.close()
            g = vzd.DoomGame()
            g.set_doom_game_path(GAMES[game]["wad"])
            g.set_doom_map(map)
            g.set_doom_skill(skill)
            g.set_window_visible(False)
            g.set_sound_enabled(False)
            g.set_console_enabled(False)
            g.set_mode(vzd.Mode.PLAYER)
            g.set_episode_timeout(0)
            g.set_screen_format(vzd.ScreenFormat.RGB24)
            g.set_screen_resolution(self._resolution(res))
            g.set_render_hud(True); g.set_render_weapon(True); g.set_render_crosshair(True); g.set_render_messages(True)
            g.set_render_decals(True); g.set_render_particles(True); g.set_render_effects_sprites(True); g.set_render_corpses(True)
            g.set_available_buttons(BUTTONS)
            g.set_button_max_value(vzd.Button.TURN_LEFT_RIGHT_DELTA, 0)
            g.set_available_game_variables(GV)
            g.set_objects_info_enabled(True)
            g.set_sectors_info_enabled(True)
            g.set_labels_buffer_enabled(True)
            g.set_automap_buffer_enabled(True)
            g.set_automap_mode(vzd.AutomapMode.NORMAL)  # what the player has explored, no object cheat
            g.set_automap_rotate(False)
            g.set_automap_render_textures(False)
            g.set_notifications_buffer_enabled(True)
            g.set_notifications_buffer_size(16)
            g.init()
            self.g, self.game, self.skill, self.res = g, game, skill, res
        else:
            self.g.set_doom_map(map)
        self.map = map
        self.g.new_episode()
        self.started_at = time.time()
        self.turns = 0
        self.seen_monsters = set()
        self.action_log = []
        # ViZDoom ignores player input for the first ~7 tics of an episode (measured:
        # turns and moves issued in tics 1-6 are dropped) — burn them here so the
        # agent's first action counts.
        self.g.make_action([0] * len(BUTTONS), 10)
        st = self.g.get_state()
        self.nav = NavMap(st.sectors) if st is not None and st.sectors else None
        self.visited = set()
        self.gave_up = {}
        self._mark_visited(st)
        return self.observe(events=[f"Started {game} {map} on skill {skill} ({SKILLS[skill]})."], image=image, image_scale=float(image_scale))

    @staticmethod
    def _resolution(res):
        name = f"RES_{res[0]}X{res[1]}"
        if not hasattr(vzd.ScreenResolution, name):
            raise ValueError(f"unsupported resolution {res[0]}x{res[1]} (try 320x240, 400x300, 640x480)")
        return getattr(vzd.ScreenResolution, name)

    def close(self):
        if self.g is not None:
            try:
                self.g.close()
            except Exception:
                pass
        self.g = None

    def require(self):
        if self.g is None:
            raise RuntimeError("no game running — call start first")

    # ── raw state helpers ──
    def vars(self):
        s = self.g.get_state()
        if s is None:  # episode finished: get_state() is None; fall back to the per-variable API
            return None
        return s.game_variables

    def gv(self, v, vars_=None):
        if vars_ is not None:
            return float(vars_[GI[v]])
        return float(self.g.get_game_variable(v))

    def finished(self):
        return self.g.is_episode_finished()

    def dead(self):
        return self.g.is_player_dead()

    # ── observation ──
    def observe(self, events=None, image="frame", image_scale=1.0):
        self.require()
        g = self.g
        s = g.get_state()
        out = {"game": self.game, "map": self.map, "skill": self.skill, "turn": self.turns,
               "finished": self.finished(), "dead": self.dead(), "events": events or []}
        if s is None:
            out["status"] = {"note": "episode over (dead or level complete) — start again"}
            if self.last_frame is not None and image in ("frame", "both"):
                out["frame_jpeg"] = jpeg_b64(self.last_frame, scale=image_scale)
            return out
        v = s.game_variables
        self.last_frame = s.screen_buffer
        self.last_automap = s.automap_buffer
        px, py, pz = v[GI[vzd.GameVariable.POSITION_X]], v[GI[vzd.GameVariable.POSITION_Y]], v[GI[vzd.GameVariable.POSITION_Z]]
        pa = v[GI[vzd.GameVariable.ANGLE]]
        sel = int(v[GI[vzd.GameVariable.SELECTED_WEAPON]])
        wnames = HERETIC_WEAPONS if self.game == "heretic" else WEAPON_NAMES
        anames = {} if self.game == "heretic" else AMMO_SLOTS   # Heretic ammo slots are unverified; the HUD shows them
        weapons = [wnames[i] for i in range(1, 9) if v[GI[getattr(vzd.GameVariable, f"WEAPON{i}")]] > 0]
        out["status"] = {
            "health": int(v[GI[vzd.GameVariable.HEALTH]]), "armor": int(v[GI[vzd.GameVariable.ARMOR]]),
            "weapon": wnames.get(sel, f"slot {sel}"), "weapon_slot": sel,
            "weapon_ammo": int(v[GI[vzd.GameVariable.SELECTED_WEAPON_AMMO]]),
            "ammo": {name: int(v[GI[getattr(vzd.GameVariable, f"AMMO{slot}")]]) for slot, name in anames.items()},
            "weapons": weapons,
            "kills": int(v[GI[vzd.GameVariable.KILLCOUNT]]), "items": int(v[GI[vzd.GameVariable.ITEMCOUNT]]),
            "secrets": int(v[GI[vzd.GameVariable.SECRETCOUNT]]),
            "time_s": round(g.get_episode_time() / TICS_PER_SEC, 1),
        }
        out["position"] = {"x": round(px), "y": round(py), "z": round(pz), "angle": round(pa) % 360, "facing": compass(pa)}
        here = self._mark_visited(s)
        if self.nav is not None and here is not None:
            ops = []
            for o in self.nav.openings(here, px, py, s.sectors, self.visited)[:6]:
                rel = ang_norm(math.degrees(math.atan2(o["y"] - py, o["x"] - px)) - pa)
                ops.append({"kind": o["kind"], "bearing": round(-rel), "distance": round(o["distance"]), "x": round(o["x"]), "y": round(o["y"]),
                            "explored": o["explored"], "width": o["width"]})
            out["openings"] = ops
            walkable = self.nav.n - len(self.nav.door_like)
            out["explored"] = {"visited": len(self.visited - self.nav.door_like), "total": walkable}
        # what is in view
        W, H = self.res
        visible, seen_ids = [], set()
        for l in s.labels:
            if l.object_category == "Self" or l.object_category not in INTERESTING:
                continue
            if l.width == 0 or l.height == 0:
                continue
            cx = l.x + l.width / 2
            bearing = math.degrees(math.atan((cx - W / 2) / (W / 2) * math.tan(math.radians(FOV / 2))))
            dist = math.hypot(l.object_position_x - px, l.object_position_y - py)
            seen_ids.add(l.object_id)
            visible.append({"id": l.object_id, "name": l.object_name, "label": MONSTER_NAMES.get(l.object_name, l.object_name),
                            "category": l.object_category.lower(), "bearing": round(bearing),
                            "distance": round(dist), "px": [l.x, l.y, l.width, l.height]})
        visible.sort(key=lambda o: (o["category"] != "monster", o["distance"]))
        out["visible"] = visible
        new_monsters = [o for o in visible if o["category"] == "monster" and o["id"] not in self.seen_monsters]
        # Only monsters within 900 units count as seen; a speck in the distance still earns an "enemy sighted" stop later.
        self.seen_monsters.update(o["id"] for o in visible if o["category"] == "monster" and o["distance"] <= 900)
        out["new_monsters"] = [o["id"] for o in new_monsters]
        # nearby but not in view (monsters only — "you hear something")
        heard = []
        for o in s.objects:
            if o.category != "Monster" or o.id in seen_ids:
                continue
            dist = math.hypot(o.position_x - px, o.position_y - py)
            if dist > 600:
                continue
            rel = ang_norm(math.degrees(math.atan2(o.position_y - py, o.position_x - px)) - pa)
            heard.append({"id": o.id, "label": MONSTER_NAMES.get(o.name, o.name), "distance": round(dist), "bearing": round(-rel)})
        heard.sort(key=lambda o: o["distance"])
        out["heard"] = heard[:5]
        # wall clearance by ray cast
        out["clearance"] = self.clearance(s, px, py, pz, pa)
        # notifications (pickup messages etc.)
        self._collect_notes(s)
        if self.notes:
            out["messages"] = list(dict.fromkeys(self.notes))
            self.notes = []
        # The automap follows the player; crop the middle half and double it so it is readable at 320×240.
        am = s.automap_buffer
        ah, aw = am.shape[0], am.shape[1]
        am = am[ah // 4: 3 * ah // 4, aw // 4: 3 * aw // 4]
        if image in ("frame", "both"):
            out["frame_jpeg"] = jpeg_b64(s.screen_buffer, scale=image_scale)
        if image in ("automap", "both"):
            out["automap_jpeg"] = jpeg_b64(am, scale=2.0 * image_scale)
        # Always a full-size pair for the people watching, whatever the player asked for.
        out["view"] = {"frame": jpeg_b64(s.screen_buffer), "automap": jpeg_b64(am, scale=2.0)}
        if self.frames_dir:
            try:
                Image.fromarray(s.screen_buffer).save(os.path.join(self.frames_dir, "latest.jpg"), quality=80)
                Image.fromarray(s.automap_buffer).save(os.path.join(self.frames_dir, "automap.jpg"), quality=80)
            except Exception as e:
                log("frame save failed:", e)
        return out

    def _me(self, s):
        for o in s.objects:
            if o.category == "Self":
                return o
        return None

    def _player_sector(self, s=None):
        s = s if s is not None else self.g.get_state()
        if s is None or self.nav is None:
            return None
        me = self._me(s)
        if me is not None and 0 <= me.sector_id < self.nav.n:
            return int(me.sector_id)
        return self.nav.point_sector(float(self.g.get_game_variable(vzd.GameVariable.POSITION_X)), float(self.g.get_game_variable(vzd.GameVariable.POSITION_Y)))

    def _mark_visited(self, s=None):
        sec = self._player_sector(s)
        if sec is not None:
            self.visited.add(sec)
        return sec

    def _collect_notes(self, s):
        try:
            nb = s.notifications_buffer if s is not None else ""
            for n in str(nb or "").replace("\r", "").split("\n"):
                n = "".join(ch for ch in n if ch.isprintable()).strip()
                if not n or n.startswith("No bots file"):
                    continue
                if n.startswith("+"):
                    n = "Map: " + n[1:].strip()
                if not self.notes or self.notes[-1] != n:
                    self.notes.append(n)
        except Exception:
            pass

    def clearance(self, s, px, py, pz, pa):
        """Distance to the nearest wall/closed door at several bearings (degrees, + = right)."""
        sectors = s.sectors or []
        # map each line (unordered endpoint key) to the sectors it borders
        lines = {}
        for sec in sectors:
            for ln in sec.lines:
                key = tuple(sorted(((round(ln.x1), round(ln.y1)), (round(ln.x2), round(ln.y2)))))
                e = lines.setdefault(key, {"x1": ln.x1, "y1": ln.y1, "x2": ln.x2, "y2": ln.y2, "blocking": bool(ln.is_blocking), "sectors": []})
                e["sectors"].append(sec)
        # which sector are we in? the one whose floor is closest to our z among candidates: ViZDoom gives no point-in-sector,
        # so approximate "passable" using only the far side's geometry relative to our z.
        bearings = [-90, -45, -20, 0, 20, 45, 90]
        out = []
        for b in bearings:
            a = math.radians(pa - b)
            dx, dy = math.cos(a), math.sin(a)
            best, kind = 2000.0, "open"
            for e in lines.values():
                t = ray_segment(px, py, dx, dy, e["x1"], e["y1"], e["x2"], e["y2"])
                if t is None or t >= best:
                    continue
                two_sided = len(e["sectors"]) >= 2
                if not two_sided:
                    best, kind = t, "wall"
                    continue
                if e["blocking"]:
                    best, kind = t, "fence"   # see-through barrier (window, railing, grate)
                    continue
                # two-sided: passable if some bordering sector is open relative to our floor
                passable, door = False, False
                for sec in e["sectors"]:
                    gap = sec.ceiling_height - sec.floor_height
                    step = sec.floor_height - pz
                    if gap <= 0:
                        door = True
                        continue
                    if gap >= 56 and step <= 24:
                        passable = True
                if not passable:
                    best, kind = t, ("door" if door else "ledge")
            out.append({"bearing": b, "distance": int(best) if best < 2000 else 2000, "hit": kind})
        return out

    # ── acting ──
    def act(self, actions, stop_on=None, image="frame", image_scale=1.0):
        self.require()
        if self.finished():
            return self.observe(events=["Episode is over — start a new one."], image=image, image_scale=image_scale)
        stop_on = set(stop_on if stop_on is not None else ["damage", "enemy", "dead", "level"])
        self.turns += 1
        events = []
        done_reason = None
        before = self._snapshot()
        self.notes = []
        descs = []
        for i, action in enumerate(actions):
            if self.finished():
                break
            desc, reason = self._run_action(action, stop_on, events)
            self.action_log.append(desc)
            descs.append(desc)
            if reason:
                done_reason = reason
                events.append(f"Stopped after action {i + 1} ({desc}): {reason}." + (f" {len(actions) - i - 1} queued action(s) dropped." if i + 1 < len(actions) else ""))
                break
        after = self._snapshot()
        events[0:0] = self._diff_events(before, after)
        if descs:
            events.insert(0, "Did: " + " · ".join(descs) + ".")
        if self.dead():
            events.append("YOU DIED. Call game_start to try the level again.")
        elif self.finished():
            events.append(f"LEVEL COMPLETE — {self.map} finished in {after['time_s']}s with {after['kills']} kills, {after['items']} items, {after['secrets']} secrets. Call game_start with the next map.")
        obs = self.observe(events=events, image=image, image_scale=image_scale)
        obs["stopped_early"] = done_reason
        return obs

    def _snapshot(self):
        g = self.g
        return {k: float(g.get_game_variable(v)) for k, v in (
            ("health", vzd.GameVariable.HEALTH), ("armor", vzd.GameVariable.ARMOR), ("kills", vzd.GameVariable.KILLCOUNT),
            ("items", vzd.GameVariable.ITEMCOUNT), ("secrets", vzd.GameVariable.SECRETCOUNT), ("hits", vzd.GameVariable.HITCOUNT),
            ("damage_dealt", vzd.GameVariable.DAMAGECOUNT), ("damage_taken", vzd.GameVariable.DAMAGE_TAKEN),
            ("x", vzd.GameVariable.POSITION_X), ("y", vzd.GameVariable.POSITION_Y), ("angle", vzd.GameVariable.ANGLE),
            ("ammo", vzd.GameVariable.SELECTED_WEAPON_AMMO))} | {"time_s": round(g.get_episode_time() / TICS_PER_SEC, 1)}

    def _diff_events(self, a, b):
        ev = []
        if b["damage_taken"] > a["damage_taken"]:
            ev.append(f"Took {int(b['damage_taken'] - a['damage_taken'])} damage; health {int(a['health'])} → {int(b['health'])}" + (" (healed by pickups meanwhile)." if b['health'] >= a['health'] else "."))
        if b["kills"] > a["kills"]:
            ev.append(f"Killed {int(b['kills'] - a['kills'])} enemy(ies).")
        if b["hits"] > a["hits"]:
            ev.append(f"Landed {int(b['hits'] - a['hits'])} hit(s) for {int(b['damage_dealt'] - a['damage_dealt'])} damage.")
        if b["items"] > a["items"]:
            ev.append(f"Picked up {int(b['items'] - a['items'])} item(s).")
        if b["secrets"] > a["secrets"]:
            ev.append("Found a secret!")
        moved = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
        turned = ang_norm(b["angle"] - a["angle"])
        ev.append(f"Moved {int(moved)} units, turned {int(abs(turned))}° {'left' if turned > 0 else 'right'}, {b['time_s'] - a['time_s']:.1f}s of game time." if moved >= 1 or abs(turned) >= 1 else f"Stayed put, {b['time_s'] - a['time_s']:.1f}s of game time.")
        return ev

    def _press(self, **kw):
        v = [0] * len(BUTTONS)
        for name, val in kw.items():
            v[BI[getattr(vzd.Button, name)]] = val
        return v

    def _step(self, vec, tics, stop_on, watch):
        """Advance `tics` tics holding `vec`, checking stop conditions every few tics. Returns stop reason or None."""
        chunk = 5
        left = tics
        while left > 0:
            n = min(chunk, left)
            self.g.make_action(vec, n)
            left -= n
            r = self._check(stop_on, watch)
            if r:
                return r
        return None

    def _check(self, stop_on, watch):
        g = self.g
        if g.is_player_dead():
            return "you died"
        if g.is_episode_finished():
            return "level complete"
        h = float(g.get_game_variable(vzd.GameVariable.HEALTH))
        if "damage" in stop_on and h < watch["health"]:
            watch["health"] = h
            return f"took damage (health now {int(h)})"
        watch["health"] = h
        s = g.get_state()
        self._collect_notes(s)
        if s is not None:
            self._mark_visited(s)
        if "enemy" in stop_on:
            if s is not None:
                for l in s.labels:
                    if l.object_category == "Monster" and l.object_id not in self.seen_monsters and l.width > 0:
                        px, py = float(g.get_game_variable(vzd.GameVariable.POSITION_X)), float(g.get_game_variable(vzd.GameVariable.POSITION_Y))
                        d = math.hypot(l.object_position_x - px, l.object_position_y - py)
                        if d > 900:
                            continue  # a speck in the distance is not worth a turn; it stays "new" until it is closer
                        self.seen_monsters.add(l.object_id)
                        return f"enemy sighted: {MONSTER_NAMES.get(l.object_name, l.object_name)} at {int(d)} units"
        return None

    def _watch(self):
        return {"health": float(self.g.get_game_variable(vzd.GameVariable.HEALTH))}

    def _turn(self, degrees, stop_on, watch):
        """Turn by `degrees` (+ = right/clockwise). Exact, via the delta button."""
        remaining = float(degrees)
        while abs(remaining) > 0.01:
            d = max(-MAX_TURN_PER_TIC, min(MAX_TURN_PER_TIC, remaining))
            self.g.make_action(self._press(TURN_LEFT_RIGHT_DELTA=d), 1)
            remaining -= d
        return self._check(stop_on, watch)

    def _bearing_to(self, x, y):
        px = float(self.g.get_game_variable(vzd.GameVariable.POSITION_X))
        py = float(self.g.get_game_variable(vzd.GameVariable.POSITION_Y))
        pa = float(self.g.get_game_variable(vzd.GameVariable.ANGLE))
        rel = ang_norm(math.degrees(math.atan2(y - py, x - px)) - pa)
        return -rel, math.hypot(x - px, y - py)  # + = right

    def _find_object(self, oid):
        s = self.g.get_state()
        if s is None:
            return None
        for o in s.objects:
            if o.id == oid:
                return o
        return None

    def _run_action(self, action, stop_on, events):
        """Execute one action dict. Returns (description, stop_reason|None)."""
        if isinstance(action, str):
            action = {action: True}
        if not isinstance(action, dict) or not action:
            raise ValueError(f"bad action: {action!r}")
        watch = self._watch()
        run = bool(action.get("run", True))
        if "move" in action:
            direction = str(action["move"]).lower()
            btn = {"forward": "MOVE_FORWARD", "back": "MOVE_BACKWARD", "backward": "MOVE_BACKWARD", "left": "MOVE_LEFT", "right": "MOVE_RIGHT"}.get(direction)
            if not btn:
                raise ValueError(f"move must be forward|back|left|right, got {direction!r}")
            tics = int(action.get("tics") or round(float(action.get("seconds", 1.0)) * TICS_PER_SEC))
            tics = max(1, min(tics, 35 * 20))
            vec = self._press(**{btn: 1, "SPEED": 1 if run else 0})
            x0, y0 = self._pos()
            reason = self._step_stuck(vec, tics, stop_on, watch)
            self._brake()
            x1, y1 = self._pos()
            return f"move {direction} {tics} tics (went {int(math.hypot(x1 - x0, y1 - y0))} units)", reason
        if "turn" in action:
            deg = float(action["turn"])
            return f"turn {int(deg)}° {'right' if deg > 0 else 'left'}", self._turn(deg, stop_on, watch)
        if "face" in action:
            tgt = action["face"]
            if isinstance(tgt, (list, tuple)) and len(tgt) == 2:
                b, d = self._bearing_to(float(tgt[0]), float(tgt[1]))
                what = f"({int(tgt[0])},{int(tgt[1])})"
            else:
                o = self._find_object(int(tgt))
                if o is None:
                    events.append(f"face: object #{tgt} is no longer in the map (picked up, destroyed or never existed).")
                    return f"face #{tgt} (gone)", None
                b, d = self._bearing_to(o.position_x, o.position_y)
                what = f"{MONSTER_NAMES.get(o.name, o.name)} #{o.id} ({int(d)} units)"
            return f"face {what}: turned {int(b)}°", self._turn(b, stop_on, watch)
        if "explore" in action:
            max_tics = max(10, min(int(action.get("max_tics", 35 * 12)), 35 * 30))
            s = self.g.get_state()
            here = self._player_sector(s)
            if self.nav is None or here is None:
                return "explore (no map)", None
            px, py = self._pos()
            skip = self.visited | {k for k, v in self.gave_up.items() if v >= 2}
            found = self.nav.nearest_unexplored_cell(px, py, s.sectors, skip)
            if not found:
                events.append("explore: every reachable area has been visited — look for doors that need a key or a switch.")
                return "explore: nothing unvisited reachable", None
            cell, target = found
            tx, ty = self.nav.cell_xy(cell)
            desc, reason = self._navigate(tx, ty, target, f"unexplored area #{target}", 12, max_tics, stop_on, watch, events, run, enter_only=True)
            if target not in self.visited and (reason and "stuck" in reason or "did not get in" in desc):
                self.gave_up[target] = self.gave_up.get(target, 0) + 1
                if self.gave_up[target] >= 2:
                    events.append(f"explore: giving up on area #{target} (can't get in from here); moving on to other areas.")
            return "explore → " + desc, reason
        if "goto" in action:
            tgt = action["goto"]
            stop_dist = float(action.get("within", 48))
            max_tics = max(10, min(int(action.get("max_tics", 35 * 12)), 35 * 30))
            if isinstance(tgt, (list, tuple)) and len(tgt) == 2:
                tx, ty, what = float(tgt[0]), float(tgt[1]), f"({int(tgt[0])},{int(tgt[1])})"
                tsec = self.nav.point_sector(tx, ty) if self.nav else None
            else:
                o = self._find_object(int(tgt))
                if o is None:
                    events.append(f"goto: object #{tgt} is no longer in the map (picked up, destroyed or never existed).")
                    return f"goto #{tgt} (gone)", None
                tx, ty, what = o.position_x, o.position_y, f"{MONSTER_NAMES.get(o.name, o.name)} #{o.id}"
                tsec = int(o.sector_id) if 0 <= o.sector_id < (self.nav.n if self.nav else 0) else (self.nav.point_sector(tx, ty) if self.nav else None)
            if self.nav is not None and tsec is not None:
                return self._navigate(tx, ty, tsec, what, stop_dist, max_tics, stop_on, watch, events, run)
            used = 0
            x0, y0 = self._pos()
            while used < max_tics:
                b, d = self._bearing_to(tx, ty)
                if d <= stop_dist:
                    self._brake()
                    return f"goto {what}: arrived ({int(d)} units away)", None
                if abs(b) > 3:
                    r = self._turn(b, stop_on, watch)
                    if r:
                        return f"goto {what}", r
                vec = self._press(MOVE_FORWARD=1, SPEED=1 if run else 0)
                bx, by = self._pos()
                r = self._step(vec, 10, stop_on, watch)
                used += 10
                if r:
                    return f"goto {what} ({int(d)} units left)", r
                ax, ay = self._pos()
                if math.hypot(ax - bx, ay - by) < 3:
                    b2, d2 = self._bearing_to(tx, ty)
                    return f"goto {what}", f"blocked {int(d2)} units short of the target (wall, door, ledge or obstacle in the way)"
                if r is None and used >= max_tics:
                    self._brake()
            b, d = self._bearing_to(tx, ty)
            x1, y1 = self._pos()
            return f"goto {what}: out of time, {int(d)} units left (went {int(math.hypot(x1 - x0, y1 - y0))})", None
        if "attack" in action or "shoot" in action:
            shots = action.get("attack", action.get("shoot", 1))
            shots = 1 if shots is True else max(1, int(shots))
            ammo0 = float(self.g.get_game_variable(vzd.GameVariable.SELECTED_WEAPON_AMMO))
            hits0 = float(self.g.get_game_variable(vzd.GameVariable.HITCOUNT))
            fired, tics, limit = 0, 0, shots * 45 + 10
            last_ammo = ammo0
            vec = self._press(ATTACK=1)
            melee = float(self.g.get_game_variable(vzd.GameVariable.SELECTED_WEAPON)) in (1.0, 8.0)
            while tics < limit:
                self.g.make_action(vec, 2)
                tics += 2
                if self.g.is_player_dead() or self.g.is_episode_finished():
                    break
                a = float(self.g.get_game_variable(vzd.GameVariable.SELECTED_WEAPON_AMMO))
                if a < last_ammo:
                    fired += int(last_ammo - a) if last_ammo - a < 5 else 1
                    last_ammo = a
                elif melee and tics % 20 == 0:
                    fired += 1
                if fired >= shots:
                    break
            # release and let the weapon settle for a few tics
            self.g.make_action(self._press(), 4)
            hits = int(float(self.g.get_game_variable(vzd.GameVariable.HITCOUNT)) - hits0)
            used = int(ammo0 - float(self.g.get_game_variable(vzd.GameVariable.SELECTED_WEAPON_AMMO)))
            desc = f"attack ×{shots}: {used} ammo used, {hits} hit(s)"
            if self.g.is_player_dead():
                return desc, "you died"
            close = self._close_monster()
            if close and "enemy" in stop_on:
                return desc, f"{close[0]} #{close[2]} still up at {close[1]} units"
            return desc, None
        if "use" in action:
            s = self.g.get_state()
            door = self._nearest_door_line(s) if s is not None else None
            if door is not None:
                ok, r = self._open_door(door.b, door.mx, door.my, stop_on, watch)
                if ok:
                    return "use: door opened", None
                return "use: door did not open", r
            # no door in reach: press anyway (switches), then say whether anything moved
            before = [(sec.floor_height, sec.ceiling_height) for sec in s.sectors] if s is not None else None
            self.g.make_action(self._press(USE=1), 2)
            r = self._step(self._press(), int(action.get("tics", 25)), stop_on, watch)
            s2 = self.g.get_state()
            moved = 0
            if before is not None and s2 is not None:
                moved = sum(1 for a, sec in zip(before, s2.sectors) if (sec.floor_height, sec.ceiling_height) != a)
            if moved:
                events.append(f"use: something moved ({moved} sector(s) changed height) — a switch worked.")
                return "use: switch pressed, something moved", r
            events.append("use: nothing here to use — no door within reach in front of you and nothing moved. Doors are listed under 'Openings'; stand within ~60 units facing one.")
            return "use: nothing happened", r
        if "weapon" in action:
            n = int(action["weapon"])
            if n not in WEAPON_NAMES:
                raise ValueError("weapon must be 1..8 (Doom: 1 fist, 2 pistol, 3 shotgun, 4 chaingun, 5 rocket, 6 plasma, 7 BFG, 8 chainsaw; Heretic: 1 staff, 2 wand, 3 crossbow, 4 dragon claw, 5 hellstaff, 6 phoenix rod, 7 firemace, 8 gauntlets)")
            self.g.make_action(self._press(**{f"SELECT_WEAPON{n}": 1}), 2)
            self.g.make_action(self._press(), 12)
            sel = int(float(self.g.get_game_variable(vzd.GameVariable.SELECTED_WEAPON)))
            wn = HERETIC_WEAPONS if self.game == "heretic" else WEAPON_NAMES
            if sel != n:
                events.append(f"Could not switch to {wn[n]} (not owned or no ammo); holding {wn.get(sel, sel)}.")
            return f"weapon {n} ({wn.get(sel, sel)})", None
        if "wait" in action:
            tics = action["wait"]
            tics = 35 if tics is True else max(1, min(int(tics), 35 * 30))
            return f"wait {tics} tics", self._step(self._press(), tics, stop_on, watch)
        raise ValueError(f"unknown action {list(action)[0]!r}; use move/turn/face/goto/attack/use/weapon/wait")

    def _pos(self):
        return float(self.g.get_game_variable(vzd.GameVariable.POSITION_X)), float(self.g.get_game_variable(vzd.GameVariable.POSITION_Y))

    # ── navigation ──
    def _walk_to(self, tx, ty, within, budget, stop_on, watch, run=True):
        """Straight run to a point with re-aiming, stuck recovery. Returns (tics_used, reason|None, arrived)."""
        used = 0
        best_d = float("inf")
        no_progress = 0      # tics without getting closer
        nudges = 0
        while used < budget:
            b, d = self._bearing_to(tx, ty)
            if d <= within:
                return used, None, True
            if d < best_d - 4:
                best_d, no_progress = d, 0
            if abs(b) > 4:
                r = self._turn(b, stop_on, watch)
                if r:
                    return used, r, False
            r = self._step(self._press(MOVE_FORWARD=1, SPEED=1 if run else 0), 5, stop_on, watch)
            used += 5
            no_progress += 5
            if r:
                return used, r, False
            if no_progress >= 15:
                # not getting closer: hand back to the planner (it re-routes from where we actually are)
                return used, "replan", False
        return used, None, False

    def _open_door(self, door_sector, mx, my, stop_on, watch):
        """Stand before the door line, press use, wait for it to rise. Returns (ok, reason)."""
        used, r, arrived = self._walk_to(mx, my, 36, 35 * 4, stop_on, watch)
        if r:
            return False, r
        b, _ = self._bearing_to(mx, my)
        self._turn(b, stop_on, watch)
        for attempt in range(2):
            self.g.make_action(self._press(USE=1), 2)
            for _ in range(10):
                self.g.make_action(self._press(), 5)
                s = self.g.get_state()
                if s is None:
                    return False, "episode ended"
                if not self.nav.closed(door_sector, s.sectors):
                    self.g.make_action(self._press(), 10)  # let it rise a little more
                    return True, None
            # nudge closer and retry once
            self.g.make_action(self._press(MOVE_FORWARD=1), 6)
        s = self.g.get_state()
        return False, "the door would not open (locked — needs a key or a switch elsewhere?)"

    def _navigate(self, tx, ty, tsec, what, within, max_tics, stop_on, watch, events, run=True, enter_only=False):
        used = 0
        replans = 0
        no_gain = 0
        last_pos = self._pos()
        desc_path = "?"
        doors_opened = 0
        while True:
            s = self.g.get_state()
            if s is None:
                return f"goto {what}", "episode ended"
            px, py = self._pos()
            cells = self.nav.path_cells(px, py, tx, ty, s.sectors)
            if cells is None:
                if replans == 0:
                    events.append(f"goto {what}: no walkable route from here (a locked door, a lift or a ledge is in the way) — trying a straight run.")
                wps = [("walk", tx, ty)]
            else:
                wps = self.nav.waypoints(cells, s.sectors)
            if replans == 0:
                doors = sum(1 for w in wps if w[0] == "door")
                legs = sum(1 for w in wps if w[0] == "walk")
                desc_path = f"{legs} leg(s), {doors} door(s)" if cells is not None else "straight line"
            outcome = None   # "done" | "replan" | reason
            for w in wps:
                if used >= max_tics:
                    outcome = "time"
                    break
                if w[0] == "door":
                    _, dsec, dx, dy = w
                    if self.nav.closed(dsec, self.g.get_state().sectors):
                        ok, r = self._open_door(dsec, dx, dy, stop_on, watch)
                        if not ok:
                            return f"goto {what}: stopped at a door", r
                        doors_opened += 1
                        events.append("Opened a door.")
                    continue
                _, wx, wy = w
                last = w is wps[-1]
                n, r, arrived = self._walk_to(wx, wy, within if last else 14, max_tics - used, stop_on, watch, run)
                used += n
                if r == "replan":
                    outcome = "replan"
                    break
                if r:
                    return f"goto {what} (en route, {desc_path})", r
                if not arrived:
                    outcome = "time"
                    break
            else:
                outcome = "done"
            if outcome == "done":
                break
            if outcome == "time":
                return f"goto {what}: out of time on the way ({desc_path})", None
            # replan: did we get anywhere since the last replan?
            qx, qy = self._pos()
            if math.hypot(qx - last_pos[0], qy - last_pos[1]) < 12:
                no_gain += 1
                # a small sideways shuffle to unhook from a corner, alternating sides
                self.g.make_action(self._press(**{"MOVE_LEFT" if no_gain % 2 else "MOVE_RIGHT": 1}), 5)
                used += 5
            else:
                no_gain = 0
            last_pos = (qx, qy)
            replans += 1
            if no_gain >= 3 or replans >= 12:
                return f"goto {what} ({desc_path})", "stuck (wall, pillar or obstacle in the way)"
        self._brake()
        via = desc_path + (f", re-routed {replans}×" if replans else "")
        if enter_only:
            here = self._mark_visited()
            if here == tsec or tsec in self.visited:
                return f"goto {what}: entered it ({via})", None
            return f"goto {what}: reached its edge but did not get in ({via})", None
        _, d = self._bearing_to(tx, ty)
        if d <= within + 8:
            return f"goto {what}: arrived ({int(d)} units away, {via})", None
        return f"goto {what}: ended {int(d)} units short ({via})", None

    def _nearest_door_line(self, s, max_dist=120, max_bearing=70):
        """Nearest door-line (edge into a door-like sector) in front of the player."""
        here = self._player_sector(s)
        if self.nav is None or here is None:
            return None
        px, py = self._pos()
        pa = float(self.g.get_game_variable(vzd.GameVariable.ANGLE))
        best = None
        for e in self.nav.edges.get(here, []):
            if e.b not in self.nav.door_like:
                continue
            d = math.hypot(e.mx - px, e.my - py)
            rel = abs(ang_norm(math.degrees(math.atan2(e.my - py, e.mx - px)) - pa))
            if d <= max_dist and rel <= max_bearing and (best is None or d < best[0]):
                best = (d, e)
        return best[1] if best else None

    def _brake(self):
        """Doom keeps sliding after you let go; six idle tics settle the player before the next action."""
        if not self.g.is_episode_finished():
            self.g.make_action(self._press(), 6)

    def _close_monster(self, limit=240):
        s = self.g.get_state()
        if s is None:
            return None
        px, py = self._pos()
        best = None
        for l in s.labels:
            if l.object_category == "Monster" and l.width > 0:
                d = math.hypot(l.object_position_x - px, l.object_position_y - py)
                if d <= limit and (best is None or d < best[1]):
                    best = (MONSTER_NAMES.get(l.object_name, l.object_name), int(d), l.object_id)
        return best

    def _step_stuck(self, vec, tics, stop_on, watch):
        """Like _step but also stops when the player stops making progress (wall/obstacle)."""
        left = tics
        stuck_chunks = 0
        while left > 0:
            n = min(5, left)
            bx, by = self._pos()
            self.g.make_action(vec, n)
            left -= n
            r = self._check(stop_on, watch)
            if r:
                return r
            ax, ay = self._pos()
            if math.hypot(ax - bx, ay - by) < 1.0:
                stuck_chunks += 1
                if stuck_chunks >= 2 and tics - left >= 10:
                    return "blocked (wall, closed door, ledge or obstacle)"
            else:
                stuck_chunks = 0
        return None


def ray_segment(px, py, dx, dy, x1, y1, x2, y2):
    """Ray (px,py)+t(dx,dy), t>0 vs segment. Returns t or None."""
    ex, ey = x2 - x1, y2 - y1
    den = dx * ey - dy * ex
    if abs(den) < 1e-9:
        return None
    t = ((x1 - px) * ey - (y1 - py) * ex) / den
    u = ((x1 - px) * dy - (y1 - py) * dx) / den
    if t > 0 and 0 <= u <= 1:
        return t
    return None


# ───────────────────────── protocol loop ─────────────────────────

def main():
    doom = Doom()
    out = sys.stdout
    import signal
    def bye(*_):
        doom.close()
        sys.exit(0)
    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)
    sys.stdout = sys.stderr  # anything the engine prints must not corrupt the protocol stream
    def reply(obj):
        out.write(json.dumps(obj) + "\n")
        out.flush()
    reply({"id": None, "ok": True, "result": {"hello": "doom-sidecar", "vizdoom": vzd.__version__, "games": list(GAMES)}})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            reply({"id": None, "ok": False, "error": f"bad json: {e}"})
            continue
        rid, op, args = req.get("id"), req.get("op"), req.get("args") or {}
        try:
            t0 = time.time()
            if op == "games":
                res = {"games": {k: {"title": v["title"], "maps": v["maps"]} for k, v in GAMES.items()}, "skills": SKILLS}
            elif op == "start":
                res = doom.start(**args)
            elif op == "act":
                res = doom.act(args.get("actions") or [], args.get("stop_on"), args.get("image", "frame"), float(args.get("image_scale", 1.0)))
            elif op == "look":
                res = doom.observe(image=args.get("image", "frame"), image_scale=float(args.get("image_scale", 1.0)))
            elif op == "state":
                res = doom.observe(image="none")
            elif op == "stop":
                doom.close()
                res = {"stopped": True}
            elif op == "ping":
                res = {"pong": True, "running": doom.g is not None}
            else:
                raise ValueError(f"unknown op {op!r}")
            if isinstance(res, dict):
                res["took_ms"] = int((time.time() - t0) * 1000)
            reply({"id": rid, "ok": True, "result": res})
        except Exception as e:
            log("error:", repr(e))
            reply({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})
    doom.close()  # stdin closed: the server is gone, take the engine with us


if __name__ == "__main__":
    main()
