import { describe, expect, it } from 'bun:test';
import { WORLD_PATH, WORLD_VIEWBOX, project } from '../web/src/worldPath';

interface Ring { pts: [number, number][]; }

/** Parse the path back into rings, which is the only way to check its shape. */
function rings(): Ring[] {
  return WORLD_PATH.split('M').filter((c) => c.trim()).map((chunk) => ({
    pts: [...chunk.matchAll(/(-?[\d.]+)[, ](-?[\d.]+)/g)]
      .map((m) => [Number(m[1]), Number(m[2])] as [number, number]),
  }));
}

describe('the world outline', () => {
  it('has a closed subpath for every move', () => {
    // Rings run together when a Z goes missing, and the fill then bridges two
    // unrelated landmasses.
    const m = (WORLD_PATH.match(/M/g) ?? []).length;
    const z = (WORLD_PATH.match(/Z/g) ?? []).length;
    expect(m).toBe(z);
    expect(m).toBeGreaterThan(100);
  });

  it('stays inside the viewBox', () => {
    for (const { pts } of rings()) {
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(WORLD_VIEWBOX.w);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(WORLD_VIEWBOX.h);
      }
    }
  });

  it('never jumps the antimeridian, except along a pole', () => {
    /**
     * The defect this guards. Russia, Fiji, Wrangel Island and Antarctica all
     * cross +-180; projected naively, x leaps from 1000 to 0 and the fill
     * draws a solid bar across the entire map at that latitude. Two such bars
     * shipped, at 72N and 16S.
     *
     * A jump along y=0 or y=500 is the exception and is correct: that is a
     * polar cap closing along the edge of the map, which is how Antarctica
     * gets a bottom at all.
     */
    const offenders: string[] = [];
    for (const [i, { pts }] of rings().entries()) {
      for (let j = 1; j < pts.length; j++) {
        const [x0, y0] = pts[j - 1];
        const [x1, y1] = pts[j];
        if (Math.abs(x1 - x0) <= WORLD_VIEWBOX.w / 2) continue;
        const onPole = (y: number) => y <= 0.01 || y >= WORLD_VIEWBOX.h - 0.01;
        if (onPole(y0) && onPole(y1)) continue;
        offenders.push(`ring ${i} at lat ${(90 - (y0 / WORLD_VIEWBOX.h) * 180).toFixed(1)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches the south pole, so Antarctica is filled and not a floating strip', () => {
    const maxY = Math.max(...rings().flatMap((r) => r.pts.map(([, y]) => y)));
    expect(maxY).toBeCloseTo(WORLD_VIEWBOX.h, 1);
  });

  it('covers both hemispheres east to west', () => {
    const xs = rings().flatMap((r) => r.pts.map(([x]) => x));
    expect(Math.min(...xs)).toBeLessThan(1);
    expect(Math.max(...xs)).toBeGreaterThan(WORLD_VIEWBOX.w - 1);
  });
});

describe('projecting a peer onto it', () => {
  it('puts the corners of the world at the corners of the box', () => {
    expect(project(-180, 90)).toEqual({ x: 0, y: 0 });
    expect(project(180, -90)).toEqual({ x: WORLD_VIEWBOX.w, y: WORLD_VIEWBOX.h });
  });

  it('puts null island at the centre', () => {
    expect(project(0, 0)).toEqual({ x: WORLD_VIEWBOX.w / 2, y: WORLD_VIEWBOX.h / 2 });
  });

  it('places real cities where they belong', () => {
    // Helsinki: north and east of centre.
    const h = project(24.9347, 60.1719);
    expect(h.x).toBeGreaterThan(WORLD_VIEWBOX.w / 2);
    expect(h.y).toBeLessThan(WORLD_VIEWBOX.h / 2);
    // Limassol is south and west of Helsinki, and still east of centre.
    const l = project(33.0366, 34.6874);
    expect(l.y).toBeGreaterThan(h.y);
    expect(l.x).toBeGreaterThan(h.x);
  });
});
