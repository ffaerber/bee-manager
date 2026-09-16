import { describe, it, expect } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer } from '../src/server';
import { loadConfig } from '../src/config';
import { hashApiKey } from '../src/auth';
import { parseOrigins } from '../src/cors';

/**
 * A browser dapp holding an app key must be able to use the Bee façade, and a
 * browser page must still never be able to drive the admin surface.
 */
describe('CORS', () => {
  const ORIGIN = 'https://dapp.example';
  const REF = 'a'.repeat(64);

  async function boot(env: Record<string, string> = {}) {
    const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ bzzBalance: '1' }) });
    const db = new Db(':memory:');
    db.upsertApp({
      name: 'app', policy: 'ephemeral', depth: 17, durationDays: 60, batchId: 'b',
      budgetPlurPerDay: 0n, ensName: null, apiKeyHash: await hashApiKey('app-key'),
    });
    const cfg = loadConfig({ BEE_URL: `http://localhost:${upstream.port}`, ...env } as any);
    const client = new BeeClient(cfg.beeUrl, 3000, 3000);
    const alerter = new Alerter(db, null, 0);
    const poller = new Poller(cfg, client, db, alerter);
    const srv = createServer({ cfg, bee: client, db, alerter, poller, adminToken: 'secret-admin' });
    srv.listen(0);
    await new Promise((r) => setTimeout(r, 120));
    const url = (p: string) => `http://localhost:${srv.server!.port}${p}`;
    const stop = () => { srv.stop?.(); upstream.stop(true); };
    return { url, stop };
  }

  const preflight = (url: string, headers: string, origin = ORIGIN) => fetch(url, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': headers },
  });

  it('answers the preflight for x-api-key on the Bee façade', async () => {
    const { url, stop } = await boot();
    try {
      const res = await preflight(url('/stamps'), 'x-api-key');
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-headers')).toBe('x-api-key');
    } finally { stop(); }
  });

  it('never allows x-admin-token, on any path', async () => {
    const { url, stop } = await boot();
    try {
      const res = await preflight(url('/stamps'), 'x-admin-token, x-api-key');
      expect(res.headers.get('access-control-allow-headers')).toBe('x-api-key');
    } finally { stop(); }
  });

  it('marks real responses readable — success, auth failure and proxied downloads', async () => {
    const { url, stop } = await boot();
    try {
      const health = await fetch(url('/health'), { headers: { origin: ORIGIN } });
      expect(health.headers.get('access-control-allow-origin')).toBe('*');

      // A dapp needs to read the 401 to tell the user their key is wrong.
      const bad = await fetch(url('/stamps'), { headers: { origin: ORIGIN, 'x-api-key': 'nope' } });
      expect(bad.status).toBe(401);
      expect(bad.headers.get('access-control-allow-origin')).toBe('*');

      const good = await fetch(url('/stamps'), { headers: { origin: ORIGIN, 'x-api-key': 'app-key' } });
      expect(good.status).toBe(200);
      expect(good.headers.get('access-control-allow-origin')).toBe('*');

      // Handlers that return a raw Response must carry the headers too.
      const dl = await fetch(url(`/bytes/${REF}`), { headers: { origin: ORIGIN, 'x-api-key': 'app-key' } });
      expect(dl.status).toBe(200);
      expect(dl.headers.get('access-control-allow-origin')).toBe('*');
    } finally { stop(); }
  });

  it('gives the admin API and the node passthrough no CORS at all', async () => {
    const { url, stop } = await boot();
    try {
      const admin = await fetch(url('/api/admin/state'), { headers: { origin: ORIGIN, 'x-admin-token': 'secret-admin' } });
      expect(admin.headers.get('access-control-allow-origin')).toBeNull();

      const wallet = await fetch(url('/wallet'), { headers: { origin: ORIGIN, 'x-admin-token': 'secret-admin' } });
      expect(wallet.status).toBe(200);
      expect(wallet.headers.get('access-control-allow-origin')).toBeNull();

      const pre = await preflight(url('/wallet'), 'x-admin-token');
      expect(pre.status).not.toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    } finally { stop(); }
  });

  it('with CORS_ORIGINS set, echoes an allowed origin and ignores the rest', async () => {
    const { url, stop } = await boot({ CORS_ORIGINS: `${ORIGIN}/, https://other.example` });
    try {
      const ok = await fetch(url('/health'), { headers: { origin: ORIGIN } });
      expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(ok.headers.get('vary')).toContain('Origin');

      const no = await fetch(url('/health'), { headers: { origin: 'https://evil.example' } });
      expect(no.headers.get('access-control-allow-origin')).toBeNull();
    } finally { stop(); }
  });

  it('parses the origin list', () => {
    expect(parseOrigins('*')).toEqual(['*']);
    expect(parseOrigins(' https://a.example/ , ,https://b.example')).toEqual(['https://a.example', 'https://b.example']);
  });
});
