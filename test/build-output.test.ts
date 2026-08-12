/**
 * Guards the built index.html against relative asset URLs.
 *
 * With Vite's `base: './'` the bundle is referenced as ./assets/index-*.js,
 * which resolves against the current path. That is invisible while every page
 * is served at '/', and breaks the instant a route has depth: reloading
 * /batch/<id> requests /batch/assets/index-*.js, gets a 404, and renders a
 * blank page. Nothing else fails — the server still returns 200 for the route,
 * so it looks fine from curl.
 *
 * Cheap to assert, and it fails loudly if someone sets base back.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const INDEX = new URL('../web/dist/index.html', import.meta.url);

describe('built dashboard', () => {
  it('exists (CI builds it before the suite)', () => {
    expect(existsSync(INDEX)).toBe(true);
  });

  it('references assets absolutely, so nested routes reload', () => {
    const html = readFileSync(INDEX, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const assets = refs.filter((r) => r.includes('assets/'));
    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets) {
      expect(a.startsWith('/assets/')).toBe(true);
    }
  });

  it('has the mount point the app renders into', () => {
    expect(readFileSync(INDEX, 'utf8')).toContain('id="root"');
  });
});
