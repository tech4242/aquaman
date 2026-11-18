/**
 * A process that writes or reads one audit log for a while, started by
 * test/e2e/audit-log-processes.test.ts:
 *
 *   tsx audit-log-child.ts writer|reader <logDir> <startAtMs> <stopAtMs>
 *
 * A writer appends entries as fast as it can, rotating every 20 kB. A reader
 * does what `aquaman audit verify` does to the log, over and over. Each
 * prints one line of JSON when the time is up.
 */

import { AuditLogger } from '../../packages/proxy/src/core/audit/logger.js';

const [role, logDir, startAt, stopAt] = process.argv.slice(2);
const until = Number(stopAt);
const access = { service: 'github', operation: 'use' as const, success: true };

await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())));

if (role === 'writer') {
  // Every archive is kept, so the whole chain can be checked from sequence 1 afterwards.
  const logger = new AuditLogger({ logDir, maxLogSizeBytes: 20_000, maxArchives: 0 });
  await logger.initialize();
  let wrote = 0;
  let failed = 0;
  while (Date.now() < until) {
    try {
      await logger.logCredentialAccess(`pid-${process.pid}`, 'agent', access);
      wrote++;
    } catch {
      failed++;
    }
  }
  console.log(JSON.stringify({ role, wrote, failed }));
} else {
  let reads = 0;
  const invalid: string[] = [];
  while (Date.now() < until) {
    const logger = new AuditLogger({ logDir, readOnly: true });
    await logger.initialize();
    const result = await logger.verifyChain();
    await logger.tail(5);
    reads++;
    if (!result.valid) invalid.push(result.errors[0]);
    await new Promise((resolve) => setImmediate(resolve));
  }
  console.log(JSON.stringify({ role, reads, invalid }));
}
