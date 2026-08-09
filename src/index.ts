/**
 * Entry point: wire the poller and the HTTP surface together.
 *
 * Note the startup banner deliberately shouts about whether auto top-up is
 * armed. This process can spend BZZ; "is it live?" should never require
 * reading the config to answer.
 */

import { loadConfig, describeConfig } from './config';
import { BeeClient } from './bee';
import { Db } from './db';
import { Alerter } from './alerts';
import { Poller } from './poller';
import { createServer } from './server';

const cfg = loadConfig();
const db = new Db(cfg.dbPath);
const bee = new BeeClient(cfg.beeUrl, cfg.beeTimeoutMs);
const alerter = new Alerter(db, cfg.webhookUrl, cfg.alertCooldownMs);
const poller = new Poller(cfg, bee, db, alerter);
const adminToken = process.env.ADMIN_TOKEN || null;

console.log('swarm-stamp-monitor');
console.log(describeConfig(cfg));
if (cfg.autoTopupEnabled && !cfg.dryRun) {
  console.log('*** AUTO TOP-UP IS ARMED — this process will spend BZZ without confirmation ***');
} else {
  console.log(`auto top-up inactive (${!cfg.autoTopupEnabled ? 'AUTO_TOPUP_ENABLED=false' : 'DRY_RUN=true'}) — planning only`);
}
if (!adminToken) console.log('ADMIN_TOKEN unset — admin routes rely entirely on the reverse proxy for auth');

poller.start();

const server = createServer({ cfg, bee, db, alerter, poller, adminToken });
server.listen(cfg.port);
console.log(`listening on :${cfg.port}`);

const shutdown = (sig: string) => {
  console.log(`\n${sig} — shutting down`);
  poller.stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
