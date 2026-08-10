import { describe, it, expect } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer } from '../src/server';
import { loadConfig } from '../src/config';
import { hashApiKey } from '../src/auth';

/**
 * The passthrough reaches /wallet, /chequebook and POST /stamps — everything
 * taking Bee off Traefik was meant to hide. An app upload key must never open
 * it, or a deploy credential becomes a wallet-drain credential.
 */
describe('passthrough is admin-only', () => {
  async function boot(adminToken: string | null) {
    const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ bzzBalance: '1' }) });
    const db = new Db(':memory:');
    db.upsertApp({
      name: 'app', policy: 'ephemeral', depth: 17, durationDays: 60, batchId: 'b',
      budgetPlurPerDay: 0n, ensName: null, apiKeyHash: await hashApiKey('app-key'),
    });
    const cfg = loadConfig({ BEE_URL: `http://localhost:${upstream.port}` } as any);
    const client = new BeeClient(cfg.beeUrl, 3000, 3000);
    const alerter = new Alerter(db, null, 0);
    const poller = new Poller(cfg, client, db, alerter);
    const srv = createServer({ cfg, bee: client, db, alerter, poller, adminToken });
    srv.listen(0);
    await new Promise((r) => setTimeout(r, 120));
    return { srv, upstream, port: srv.server!.port };
  }

  it('an app upload key CANNOT reach /wallet when a token is configured', async () => {
    const { srv, upstream, port } = await boot('secret-admin');
    try {
      const res = await fetch(`http://localhost:${port}/wallet`, { headers: { 'x-api-key': 'app-key' } });
      expect(res.status).toBe(401);
      expect((await res.json()).message).toContain('admin token');
    } finally { srv.stop?.(); upstream.stop(true); }
  });

  it('the admin token does reach it', async () => {
    const { srv, upstream, port } = await boot('secret-admin');
    try {
      const res = await fetch(`http://localhost:${port}/wallet`, { headers: { 'x-admin-token': 'secret-admin' } });
      expect(res.status).toBe(200);
    } finally { srv.stop?.(); upstream.stop(true); }
  });

  it('FAILS CLOSED with no ADMIN_TOKEN — never open just because it is unconfigured', async () => {
    const { srv, upstream, port } = await boot(null);
    try {
      const res = await fetch(`http://localhost:${port}/wallet`);
      expect(res.status).toBe(503);
      expect((await res.json()).message).toContain('disabled');
    } finally { srv.stop?.(); upstream.stop(true); }
  });

  it('admin API is disabled too when unconfigured, rather than public', async () => {
    const { srv, upstream, port } = await boot(null);
    try {
      expect((await fetch(`http://localhost:${port}/api/admin/state`)).status).toBe(503);
    } finally { srv.stop?.(); upstream.stop(true); }
  });

  it('a wrong admin token is rejected', async () => {
    const { srv, upstream, port } = await boot('right');
    try {
      const res = await fetch(`http://localhost:${port}/api/admin/state`, { headers: { 'x-admin-token': 'wrong' } });
      expect(res.status).toBe(401);
    } finally { srv.stop?.(); upstream.stop(true); }
  });

  it('the dashboard itself stays reachable without a token — it is inert without one', async () => {
    const { srv, upstream, port } = await boot('right');
    try {
      const res = await fetch(`http://localhost:${port}/`);
      expect([200, 404]).toContain(res.status); // 200 when web/dist is built
    } finally { srv.stop?.(); upstream.stop(true); }
  });
});
