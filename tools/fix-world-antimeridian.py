"""
Repair the world path: split rings that cross the antimeridian.

A ring like Russia runs east past +180 and continues at -180. Projected
naively, x leaps from 1000 to 0 and the fill draws a bar straight across the
map at that latitude. Antarctica is worse: its ring encircles the pole without
ever containing it, so the wrap smears the whole southern edge.

Fix, per ring:
  1. unwrap longitudes so the ring is continuous (may run outside +-180)
  2. if it encircles a pole, close it THROUGH that pole, which is the part
     Natural Earth leaves to the renderer
  3. emit it at -360, 0 and +360, clipping each copy to the visible strip

Clipping is Sutherland-Hodgman against the two meridians.
"""
import re
import sys

W, H = 1000.0, 500.0


def to_lonlat(x, y):
    return x / W * 360.0 - 180.0, 90.0 - y / H * 180.0


def to_xy(lon, lat):
    return (lon + 180.0) / 360.0 * W, (90.0 - lat) / 180.0 * H


def unwrap(ring):
    """Make longitudes continuous, so a crossing is no longer a 360 jump."""
    out = [ring[0]]
    off = 0.0
    for i in range(1, len(ring)):
        lon, lat = ring[i]
        prev = ring[i - 1][0] + off
        d = (lon + off) - prev
        if d > 180.0:
            off -= 360.0
        elif d < -180.0:
            off += 360.0
        out.append((lon + off, lat))
    return out


def clip_strip(poly, lo, hi):
    """Sutherland-Hodgman against lon >= lo and lon <= hi."""
    def clip(pts, keep, intersect):
        if not pts:
            return []
        out = []
        for i in range(len(pts)):
            cur, prv = pts[i], pts[i - 1]
            if keep(cur):
                if not keep(prv):
                    out.append(intersect(prv, cur))
                out.append(cur)
            elif keep(prv):
                out.append(intersect(prv, cur))
        return out

    def at(a, b, x):
        # Linear interpolation of latitude where the edge meets meridian x.
        if b[0] == a[0]:
            return (x, a[1])
        t = (x - a[0]) / (b[0] - a[0])
        return (x, a[1] + t * (b[1] - a[1]))

    poly = clip(poly, lambda p: p[0] >= lo, lambda a, b: at(a, b, lo))
    poly = clip(poly, lambda p: p[0] <= hi, lambda a, b: at(a, b, hi))
    return poly


def main(src, dst):
    s = open(src, encoding="utf8").read()
    d = re.search(r"WORLD_PATH\s*=\s*'([^']*)'", s).group(1)

    rings = []
    for chunk in d.split("M"):
        if not chunk.strip():
            continue
        pts = [(float(a), float(b))
               for a, b in re.findall(r"(-?[\d.]+)[, ](-?[\d.]+)", chunk)]
        if len(pts) >= 3:
            rings.append([to_lonlat(x, y) for x, y in pts])

    out_rings = []
    polar = 0
    split = 0
    for ring in rings:
        u = unwrap(ring)
        span = max(p[0] for p in u) - min(p[0] for p in u)

        if span >= 350.0:
            # Encircles a pole. The data traces only the coast, so the ring
            # must be closed through the pole itself — otherwise the fill
            # takes a shortcut across the map, which is the Antarctica smear.
            polar += 1
            pole = -90.0 if sum(p[1] for p in u) / len(u) < 0 else 90.0
            u = u + [(u[-1][0], pole), (u[0][0], pole)]

        emitted = 0
        for shift in (-360.0, 0.0, 360.0):
            moved = [(lon + shift, lat) for lon, lat in u]
            if max(p[0] for p in moved) < -180.0 or min(p[0] for p in moved) > 180.0:
                continue
            c = clip_strip(moved, -180.0, 180.0)
            if len(c) >= 3:
                out_rings.append(c)
                emitted += 1
        if emitted > 1:
            split += 1

    parts = []
    for r in out_rings:
        xy = [to_xy(lon, lat) for lon, lat in r]
        head = f"M{xy[0][0]:.1f},{xy[0][1]:.1f}"
        body = "".join(f"L{x:.1f},{y:.1f}" for x, y in xy[1:])
        parts.append(head + body + "Z")
    path = "".join(parts)

    s2 = re.sub(r"(WORLD_PATH\s*=\s*')[^']*(')", lambda m: m.group(1) + path + m.group(2), s, count=1)
    open(dst, "w", encoding="utf8").write(s2)

    print(f"  rings in:  {len(rings)}")
    print(f"  rings out: {len(out_rings)}   (polar closed: {polar}, split across the seam: {split})")
    print(f"  path: {len(d)} -> {len(path)} chars")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
