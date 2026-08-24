/**
 * The real service, against the fake node, with data worth photographing.
 *
 * The previous tour.gif was shot against a JSON stub, which meant any page the
 * stub did not implement rendered half-empty. This runs the actual server, so
 * every route — batch detail, the bucket map, settings, the action ledger — is
 * the real thing responding to real requests.
 */
import { FakeBee } from '../test/fake-bee';
import { BeeClient } from '../src/bee';
import { Db } from '../src/db';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer } from '../src/server';
import { loadConfig } from '../src/config';
import { PeerMapFeed } from '../src/peermap';
import { ReachabilityFeed } from '../src/reachability';

const ADMIN = 'demo-admin-token';
const DAY = 86_400;

const bee = new FakeBee();

/**
 * The fake node, plus the two endpoints the peer map needs.
 *
 * FakeBee answers everything the poller and the batch pages use, but predates
 * the map, so /peers and /addresses are added here rather than in the shared
 * fixture — a demo should not reshape the thing the test suite depends on.
 */
const PLACES = [
  ['Helsinki', 'Finland', 60.1719, 24.9347, 34],
  ['Falkenstein', 'Germany', 50.4777, 12.3649, 22],
  ['Nuremberg', 'Germany', 49.4521, 11.0767, 11],
  ['Ashburn', 'United States', 39.0438, -77.4874, 14],
  ['Beauharnois', 'Canada', 45.3151, -73.8779, 6],
  ['Amsterdam', 'Netherlands', 52.3676, 4.9041, 9],
  ['Singapore', 'Singapore', 1.3521, 103.8198, 7],
  ['Tokyo', 'Japan', 35.6762, 139.6503, 5],
  ['Sydney', 'Australia', -33.8688, 151.2093, 4],
  ['Sao Paulo', 'Brazil', -23.5558, -46.6396, 3],
  ['Warsaw', 'Poland', 52.2297, 21.0122, 6],
  ['London', 'United Kingdom', 51.5072, -0.1276, 5],
] as const;

const peerOverlays: string[] = [];
const peerPlace = new Map<string, (typeof PLACES)[number]>();
let n = 0;
for (const place of PLACES) {
  for (let i = 0; i < (place[4] as number); i++) {
    const overlay = (n++).toString(16).padStart(2, '0').repeat(32).slice(0, 64);
    peerOverlays.push(overlay);
    peerPlace.set(overlay, place);
  }
}
const SELF_OVERLAY = 'bd85c9a7' + 'f3'.repeat(28);

const node = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === '/peers') {
      return Response.json({ peers: peerOverlays.map((overlay) => ({ address: overlay })) });
    }
    if (p === '/addresses') {
      return Response.json({
        overlay: SELF_OVERLAY,
        underlay: [
          '/ip4/10.0.1.149/tcp/1634/p2p/QmDemo',
          '/ip4/62.228.14.108/tcp/1634/p2p/QmDemo',
          '/ip4/127.0.0.1/tcp/1634/p2p/QmDemo',
        ],
        ethereum: '0x195e00000000000000000000000000000000d832',
      });
    }
    if (p === '/topology') return Response.json({ connected: peerOverlays.length });
    return (bee as any).handle(req);
  },
});

/** Stands in for the public node index the map resolves positions against. */
const index = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    const m = /^\/v1\/network\/nodes\/([0-9a-f]+)$/.exec(p);
    if (m && m[1] === SELF_OVERLAY) {
      return Response.json({
        unreachable: false, handshakeMs: 1118, userAgent: 'bee/2.8.1-7cf53193',
        location: { city: 'Limassol', country: 'Cyprus', latitude: 34.6874, longitude: 33.0366 },
      });
    }
    if (m) {
      const place = peerPlace.get(m[1]);
      if (!place) return Response.json({}, { status: 404 });
      return Response.json({
        location: { city: place[0], country: place[1], latitude: place[2], longitude: place[3] },
      });
    }
    // Self is geolocated from its advertised address, as in production.
    if (p.startsWith('/json/')) {
      return Response.json({ status: 'success', country: 'Cyprus', city: 'Limassol', lat: 34.6874, lon: 33.0366 });
    }
    return Response.json({}, { status: 404 });
  },
});

const saved = { ...process.env };
Object.assign(process.env, {
  BEE_URL: `http://127.0.0.1:${node.port}`,
  DB_PATH: ':memory:',
  AUTO_TOPUP_ENABLED: 'true',
  DRY_RUN: 'false',
  TOPUP_WHEN_TTL_BELOW_DAYS: '14',
  TOPUP_TARGET_TTL_DAYS: '60',
  MAX_TOPUP_BZZ_PER_BATCH: '25',
  MAX_TOPUP_BZZ_PER_DAY: '60',
  MIN_WALLET_BZZ: '20',
  MIN_WALLET_XDAI: '0.5',
  DILUTE_ENABLED: 'true',
  PEER_MAP_ENABLED: 'true',
  PRICE_ENABLED: 'false',
  STAKE_CHECK_ENABLED: 'false',
  REACHABILITY_ENABLED: 'true',
});
const cfg = loadConfig();
process.env = saved;

const db = new Db(':memory:');
const client = new BeeClient(`http://127.0.0.1:${node.port}`, 8000, 8000, 15000);
const alerter = new Alerter(db, null, 60_000);
const peerMap = new PeerMapFeed(db, {
  enabled: true,
  perTick: 400,                       // fill it in one tick; this is a demo
  baseUrl: `http://127.0.0.1:${index.port}`,
  self: { swarmscanBase: `http://127.0.0.1:${index.port}`, geoBase: `http://127.0.0.1:${index.port}` },
});
const reach = new ReachabilityFeed({ enabled: true, baseUrl: `http://127.0.0.1:${index.port}`, ttlMs: 60_000 });
const poller = new Poller(cfg, client, db, alerter, reach, undefined, peerMap);
const app = createServer({ cfg, bee: client, db, poller, alerter, adminToken: ADMIN });
app.listen(Number(process.env.DEMO_PORT ?? 8902));

/** Amount per chunk that buys `days` at the current price. */
const forDays = (days: number) => {
  const perBlock = bee.price;
  const blocks = BigInt(Math.round((days * DAY * 1000) / 5000));
  return perBlock * blocks;
};

// ── a plausible fleet ──────────────────────────────────────────────────────
const t4t = await client.buyBatch(forDays(48), 20, { label: 't4t-website', immutable: false });
const shop = await client.buyBatch(forDays(9), 19, { label: 'freeemarket-storefront', immutable: false });
const pink = await client.buyBatch(forDays(71), 18, { label: 'pinkchainsaw-website', immutable: false });
const chat = await client.buyBatch(forDays(26), 21, { label: 'swarmchat-website', immutable: false });

// Content, so the bucket map has something to show and fullness is real.
for (let i = 0; i < 40; i++) await client.uploadBytes(t4t, new Uint8Array(96_000).fill(i % 251));
for (let i = 0; i < 26; i++) await client.uploadBytes(shop, new Uint8Array(120_000).fill(i % 241));
for (let i = 0; i < 9; i++) await client.uploadBytes(pink, new Uint8Array(48_000).fill(i % 233));
for (let i = 0; i < 18; i++) await client.uploadBytes(chat, new Uint8Array(64_000).fill(i % 239));

await poller.tick();
// A second tick after some chain movement, so the ledger has real entries and
// block time is measured rather than assumed.
bee.advanceBlocks(2_000);
await poller.tick();

console.log(`DEMO READY on ${(app as any).server?.port}`);
console.log(`  batches: ${db.liveKnownBatchIds().length}`);
console.log(`  actions: ${db.recentActions(20).length}`);
console.log(`  ADMIN=${ADMIN}`);
console.log(`  peers placed: ${db.peerLocations().length}`);
console.log(`  BATCH_T4T=${t4t}`);
console.log(`  BATCH_SHOP=${shop}`);
