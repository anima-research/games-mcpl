"""
Navigation over a ViZDoom map.

Two structures:
  * a sector graph (sectors = nodes, two-sided walkable lines = edges) used to
    describe "ways out of this area" and to pick unexplored areas;
  * a 16-unit occupancy grid used for actual path-finding (A*), built by
    rasterising sectors (for floor heights) and blocking lines (with the
    player's radius), so routes hug real geometry — concave rooms, pillars,
    doorways. Closed doors are passable in the grid only as "door" cells; the
    walker stops before them and presses use.
Heights of door sectors change while playing; the grid stores sector ids and
reads heights live.
"""
import heapq
import math

PLAYER_RADIUS = 16
WALL_MARGIN = 24      # keep cell centres this far from walls: the 32×32 box also has to clear corners
MIN_GAP = 56          # headroom a player needs
MAX_STEP = 24         # highest step a player can climb
MIN_DOORWAY = 2 * PLAYER_RADIUS + 1
CELL = 16


def _key(ln):
    return tuple(sorted(((round(ln.x1), round(ln.y1)), (round(ln.x2), round(ln.y2)))))


def _seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


class Edge:
    __slots__ = ("a", "b", "mx", "my", "length", "key")

    def __init__(self, a, b, mx, my, length, key):
        self.a, self.b, self.mx, self.my, self.length, self.key = a, b, mx, my, length, key


class NavMap:
    def __init__(self, sectors):
        self.n = len(sectors)
        self.polys = []
        self.centroids = []
        self.edges = {}
        self.lines = {}
        for i, sec in enumerate(sectors):
            pts = [(ln.x1, ln.y1, ln.x2, ln.y2) for ln in sec.lines]
            self.polys.append(pts)
            xs = [p[0] for p in pts] + [p[2] for p in pts]
            ys = [p[1] for p in pts] + [p[3] for p in pts]
            self.centroids.append((sum(xs) / max(1, len(xs)), sum(ys) / max(1, len(ys))))
            for ln in sec.lines:
                e = self.lines.setdefault(_key(ln), {"sectors": set(), "blocking": bool(ln.is_blocking), "pts": (ln.x1, ln.y1, ln.x2, ln.y2)})
                e["sectors"].add(i)
        for key, e in self.lines.items():
            if len(e["sectors"]) != 2 or e["blocking"]:
                continue
            x1, y1, x2, y2 = e["pts"]
            length = math.hypot(x2 - x1, y2 - y1)
            if length < MIN_DOORWAY:
                continue
            a, b = sorted(e["sectors"])
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            self.edges.setdefault(a, []).append(Edge(a, b, mx, my, length, key))
            self.edges.setdefault(b, []).append(Edge(b, a, mx, my, length, key))
        # doors: closed (no headroom) at episode start, few lines, two walkable neighbours
        self.door_like = set()
        for i, sec in enumerate(sectors):
            nb = {e.b for e in self.edges.get(i, [])}
            if sec.ceiling_height - sec.floor_height < MIN_GAP and len(nb) >= 2 and len(self.polys[i]) <= 8:
                self.door_like.add(i)
        self._build_grid(sectors)

    # ── grid ──
    def _build_grid(self, sectors):
        xs = [p for pts in self.polys for q in pts for p in (q[0], q[2])]
        ys = [p for pts in self.polys for q in pts for p in (q[1], q[3])]
        self.x0, self.y0 = math.floor(min(xs)) - CELL, math.floor(min(ys)) - CELL
        self.W = int((max(xs) - self.x0) // CELL) + 2
        self.H = int((max(ys) - self.y0) // CELL) + 2
        W, H = self.W, self.H
        self.cell_sector = [-1] * (W * H)
        # rasterise each sector polygon by scanline parity (cell centres)
        for i, pts in enumerate(self.polys):
            if not pts:
                continue
            ymin = min(min(p[1], p[3]) for p in pts)
            ymax = max(max(p[1], p[3]) for p in pts)
            r0 = max(0, math.ceil((ymin - self.y0) / CELL - 0.5))
            r1 = min(H - 1, math.floor((ymax - self.y0) / CELL - 0.5))
            for r in range(r0, r1 + 1):
                y = self.y0 + (r + 0.5) * CELL
                crossings = []
                for x1, y1, x2, y2 in pts:
                    if (y1 > y) != (y2 > y):
                        crossings.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
                crossings.sort()
                for k in range(0, len(crossings) - 1, 2):
                    # cells whose CENTRE lies strictly between the two crossings
                    c0 = math.ceil((crossings[k] - self.x0) / CELL - 0.5)
                    c1 = math.floor((crossings[k + 1] - self.x0) / CELL - 0.5)
                    for c in range(max(0, c0), min(W - 1, c1) + 1):
                        self.cell_sector[r * W + c] = i
        # walls: cells whose centre is within the player's radius of a blocking line
        self.wall = bytearray(W * H)
        for e in self.lines.values():
            if len(e["sectors"]) >= 2 and not e["blocking"]:
                continue
            x1, y1, x2, y2 = e["pts"]
            c0 = max(0, int((min(x1, x2) - WALL_MARGIN - self.x0) // CELL))
            c1 = min(W - 1, int((max(x1, x2) + WALL_MARGIN - self.x0) // CELL) + 1)
            r0 = max(0, int((min(y1, y2) - WALL_MARGIN - self.y0) // CELL))
            r1 = min(H - 1, int((max(y1, y2) + WALL_MARGIN - self.y0) // CELL) + 1)
            for r in range(r0, r1 + 1):
                cy = self.y0 + (r + 0.5) * CELL
                for c in range(c0, c1 + 1):
                    cx = self.x0 + (c + 0.5) * CELL
                    if _seg_dist(cx, cy, x1, y1, x2, y2) < WALL_MARGIN:
                        self.wall[r * W + c] = 1

    def cell(self, x, y):
        c = int((x - self.x0) // CELL)
        r = int((y - self.y0) // CELL)
        if 0 <= c < self.W and 0 <= r < self.H:
            return r * self.W + c
        return None

    def cell_xy(self, idx):
        r, c = divmod(idx, self.W)
        return self.x0 + (c + 0.5) * CELL, self.y0 + (r + 0.5) * CELL

    def walkable(self, idx, sectors):
        if idx is None or self.wall[idx]:
            return False
        s = self.cell_sector[idx]
        if s < 0:
            return False
        sec = sectors[s]
        if sec.ceiling_height - sec.floor_height < MIN_GAP:
            return s in self.door_like
        return True

    def _can_step(self, a, b, sectors):
        sa, sb = self.cell_sector[a], self.cell_sector[b]
        if sa == sb:
            return True
        return sectors[sb].floor_height - sectors[sa].floor_height <= MAX_STEP

    def neighbors(self, idx, sectors):
        r, c = divmod(idx, self.W)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                rr, cc = r + dr, c + dc
                if not (0 <= rr < self.H and 0 <= cc < self.W):
                    continue
                j = rr * self.W + cc
                if not self.walkable(j, sectors) or not self._can_step(idx, j, sectors):
                    continue
                if dr and dc:  # no corner cutting
                    o1, o2 = r * self.W + cc, rr * self.W + c
                    if not (self.walkable(o1, sectors) and self.walkable(o2, sectors)):
                        continue
                cost = 1.4142 if (dr and dc) else 1.0
                if self.cell_sector[j] in self.door_like:
                    cost += 2.0
                yield j, cost

    def nearest_walkable(self, x, y, sectors, radius=6):
        idx = self.cell(x, y)
        if idx is not None and self.walkable(idx, sectors):
            return idx
        r0, c0 = divmod(idx if idx is not None else 0, self.W)
        best = None
        for dr in range(-radius, radius + 1):
            for dc in range(-radius, radius + 1):
                rr, cc = r0 + dr, c0 + dc
                if 0 <= rr < self.H and 0 <= cc < self.W:
                    j = rr * self.W + cc
                    if self.walkable(j, sectors):
                        d = dr * dr + dc * dc
                        if best is None or d < best[0]:
                            best = (d, j)
        return best[1] if best else None

    def path_cells(self, sx, sy, tx, ty, sectors, max_nodes=60000):
        """A* over cells from (sx,sy) to (tx,ty). Returns a list of cell indices or None."""
        start = self.nearest_walkable(sx, sy, sectors)
        goal = self.nearest_walkable(tx, ty, sectors)
        if start is None or goal is None:
            return None
        if start == goal:
            return [start]
        gr, gc = divmod(goal, self.W)

        def h(i):
            r, c = divmod(i, self.W)
            dr, dc = abs(r - gr), abs(c - gc)
            return max(dr, dc) + 0.4142 * min(dr, dc)
        best = {start: 0.0}
        prev = {}
        heap = [(h(start), start)]
        closed = set()
        n = 0
        while heap:
            _, cur = heapq.heappop(heap)
            if cur == goal:
                break
            if cur in closed:
                continue
            closed.add(cur)
            n += 1
            if n > max_nodes:
                return None
            for j, cost in self.neighbors(cur, sectors):
                g = best[cur] + cost
                if g < best.get(j, float("inf")):
                    best[j] = g
                    prev[j] = cur
                    heapq.heappush(heap, (g + h(j), j))
        if goal not in prev:
            return None
        path = [goal]
        while path[-1] != start:
            path.append(prev[path[-1]])
        path.reverse()
        return path

    def line_clear(self, ax, ay, bx, by, sectors):
        """Straight segment stays on walkable cells (sampled every 8 units) with no step too high."""
        d = math.hypot(bx - ax, by - ay)
        steps = max(1, int(d // 8))
        last = self.cell(ax, ay)
        for k in range(1, steps + 1):
            x = ax + (bx - ax) * k / steps
            y = ay + (by - ay) * k / steps
            idx = self.cell(x, y)
            if not self.walkable(idx, sectors):
                return False
            if last is not None and not self._can_step(last, idx, sectors):
                return False
            if self.cell_sector[idx] in self.door_like and sectors[self.cell_sector[idx]].ceiling_height - sectors[self.cell_sector[idx]].floor_height < MIN_GAP:
                return False
            last = idx
        return True

    def waypoints(self, cells, sectors):
        """String-pull a cell path into few waypoints; a closed-door run becomes a ('door', sector, x, y) entry
        (x, y = the first door cell), followed by a walk to the first cell past the door."""
        if not cells:
            return []
        pts = [self.cell_xy(i) for i in cells]
        n = len(cells)

        def closed_door_cell(k):
            sk = self.cell_sector[cells[k]]
            return sk in self.door_like and sectors[sk].ceiling_height - sectors[sk].floor_height < MIN_GAP

        out = []
        i = 0
        while i < n - 1:
            if closed_door_cell(i + 1):
                sk = self.cell_sector[cells[i + 1]]
                k2 = i + 1
                while k2 < n and self.cell_sector[cells[k2]] == sk:
                    k2 += 1
                out.append(("door", sk, pts[i + 1][0], pts[i + 1][1]))
                if k2 >= n:
                    break
                out.append(("walk", pts[k2][0], pts[k2][1]))
                i = k2
                continue
            door_at = None
            for k in range(i + 1, n):
                if closed_door_cell(k):
                    door_at = k
                    break
            limit = (door_at - 1) if door_at is not None else (n - 1)
            far = i + 1
            for k in range(limit, i, -1):
                if self.line_clear(pts[i][0], pts[i][1], pts[k][0], pts[k][1], sectors):
                    far = k
                    break
            out.append(("walk", pts[far][0], pts[far][1]))
            i = far
        return out

    # ── sector-level helpers (description, exploration) ──
    def point_sector(self, x, y):
        idx = self.cell(x, y)
        if idx is not None and self.cell_sector[idx] >= 0:
            return self.cell_sector[idx]
        return min(range(self.n), key=lambda i: (self.centroids[i][0] - x) ** 2 + (self.centroids[i][1] - y) ** 2)

    def closed(self, i, sectors):
        return sectors[i].ceiling_height - sectors[i].floor_height < MIN_GAP

    def step_kind(self, a, b, sectors):
        fa, fb = sectors[a].floor_height, sectors[b].floor_height
        if b in self.door_like:
            return "door (closed)" if self.closed(b, sectors) else "door (open)"
        if fb - fa > MAX_STEP:
            return "ledge (too high)"
        if fb - fa > 0:
            return "step up"
        if fa - fb > MAX_STEP:
            return "drop"
        if fa - fb > 0:
            return "step down"
        return "opening"

    def openings(self, here, px, py, sectors, visited):
        out = []
        for e in self.edges.get(here, []):
            if sectors[e.b].floor_height - sectors[here].floor_height > MAX_STEP and e.b not in self.door_like:
                continue
            far = e.b
            explored = far in visited
            if far in self.door_like:
                beyond = [x.b for x in self.edges.get(far, []) if x.b != here]
                explored = any(b in visited for b in beyond)
            out.append({"kind": self.step_kind(here, e.b, sectors), "x": e.mx, "y": e.my, "sector": far, "explored": explored,
                        "width": int(e.length), "distance": math.hypot(e.mx - px, e.my - py)})
        out.sort(key=lambda o: o["distance"])
        return out

    def nearest_unexplored_cell(self, px, py, sectors, visited, limit_nodes=60000):
        """BFS over the grid from the player: the first cell whose sector is unvisited (and not a door). Returns (cell, sector) or None."""
        start = self.nearest_walkable(px, py, sectors)
        if start is None:
            return None
        from collections import deque
        q = deque([start])
        seen = {start}
        n = 0
        while q:
            cur = q.popleft()
            n += 1
            if n > limit_nodes:
                return None
            s = self.cell_sector[cur]
            if s not in visited and s not in self.door_like and cur != start:
                # take a cell a little inside the area, not the first border cell
                return cur, s
            for j, _ in self.neighbors(cur, sectors):
                if j not in seen:
                    seen.add(j)
                    q.append(j)
        return None


def compass(angle):
    a = angle % 360
    names = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"]
    return names[int((a + 22.5) // 45) % 8]
