/** One read-only poll against a live node: report state and intended actions. */
import { BeeClient } from './bee';
import { Db } from './db';
import { Alerter } from './alerts';
import { Poller } from './poller';
import { loadConfig, describeConfig } from './config';
import { plurToBzz, storedBytes } from './math';
import { formatBytes } from './wizard';

const cfg = loadConfig();
console.log(describeConfig(cfg), '\n');
const db = new Db(':memory:');
const poller = new Poller(cfg, new BeeClient(cfg.beeUrl, cfg.beeTimeoutMs), db, new Alerter(db, null, cfg.alertCooldownMs));
const r = await poller.tick();
if (!r.ok) { console.error('poll failed:', r.error); process.exit(1); }
console.log(`node ok — block time ~${(r.msPerBlock / 1000).toFixed(2)}s, price ${r.chain!.currentPrice} PLUR/chunk/block`);
console.log(`wallet: ${plurToBzz(r.wallet!.bzzBalance).toFixed(2)} xBZZ, ${(Number(r.wallet!.nativeTokenBalance) / 1e18).toFixed(2)} xDAI`);
console.log(`burn: ${r.burnPer30DaysBzz.toFixed(2)} xBZZ/30d  ->  runway ${r.runwayDays.toFixed(0)} days\n`);
for (const b of r.batches) {
  console.log(`  ${b.label || '(unlabelled)'}  depth ${b.depth}  TTL ${(b.batchTTL / 86400).toFixed(1)}d  ` +
    `used ${formatBytes(storedBytes(b.utilizationRatio, b.depth))} of ${formatBytes(2n ** BigInt(b.depth) * 4096n)} ` +
    `(${(b.utilizationRatio * 100).toFixed(2)}%)`);
}
console.log('\nplanned actions:');
for (const p of r.plans) console.log(`  [${p.kind}] ${p.reason}`);
db.close();
