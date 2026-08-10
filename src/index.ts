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
import { readFileSync } from 'node:fs';

const cfg = loadConfig();
const db = new Db(cfg.dbPath);
const bee = new BeeClient(cfg.beeUrl, cfg.beeTimeoutMs, cfg.beeWriteTimeoutMs);
const alerter = new Alerter(db, cfg.webhookUrl, cfg.alertCooldownMs);
const poller = new Poller(cfg, bee, db, alerter);
/**
 * Docker swarm mounts secrets as files, so ADMIN_TOKEN_FILE is the way to keep
 * the token out of git and out of `docker service inspect`. ADMIN_TOKEN stays
 * supported for local runs.
 */
function loadAdminToken(): string | null {
  const file = process.env.ADMIN_TOKEN_FILE;
  if (file) {
    try {
      const v = readFileSync(file, 'utf8').trim();
      if (v) return v;
      console.error(`ADMIN_TOKEN_FILE ${file} is empty`);
    } catch (e: any) {
      console.error(`ADMIN_TOKEN_FILE ${file} unreadable: ${e?.message ?? e}`);
    }
  }
  return process.env.ADMIN_TOKEN || null;
}
const adminToken = loadAdminToken();

console.log('swarm-stamp-monitor');
console.log(describeConfig(cfg));
if (cfg.autoTopupEnabled && !cfg.dryRun) {
  console.log('*** AUTO TOP-UP IS ARMED — this process will spend BZZ without confirmation ***');
} else {
  console.log(`auto top-up inactive (${!cfg.autoTopupEnabled ? 'AUTO_TOPUP_ENABLED=false' : 'DRY_RUN=true'}) — planning only`);
}
if (!adminToken) {
  console.log('*** ADMIN_TOKEN unset — the admin API and node passthrough are DISABLED (503). ***');
  console.log('    Set ADMIN_TOKEN_FILE (swarm secret) or ADMIN_TOKEN to enable them.');
} else {
  console.log('admin API enabled (token configured)');
}

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
