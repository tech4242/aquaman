/**
 * `aquaman audit verify` and `aquaman audit accept`.
 *
 * Both return the exit code and leave exiting to the caller.
 */

import * as readline from 'node:readline';
import { createAuditLogger } from '../core/audit/logger.js';
import type { CredentialStore } from '../core/credentials/store.js';
import { acceptAuditLog, resolveAnchorInterval, verifyAuditLog, type AuditVerification } from '../audit-anchor.js';

export interface AuditCommandDeps {
  config: { audit: { enabled: boolean; logDir: string; anchorIntervalSeconds?: unknown } };
  /** Opens the configured credential store. May throw. */
  openStore: () => Promise<CredentialStore>;
  /** Whether a proxy is serving on the socket right now. */
  proxyRunning: () => Promise<boolean>;
}

async function verification(deps: AuditCommandDeps, chainOnly: boolean): Promise<{ report: AuditVerification; logger: ReturnType<typeof createAuditLogger> }> {
  const logger = createAuditLogger({ logDir: deps.config.audit.logDir, enabled: true });
  await logger.initialize();
  const report = await verifyAuditLog({
    logger,
    openStore: deps.openStore,
    anchoring: deps.config.audit.enabled && resolveAnchorInterval(deps.config) > 0,
    chainOnly,
  });
  return { report, logger };
}

function printReport(report: AuditVerification): void {
  const { chain, anchor } = report;
  const anchorLine = `Anchor: ${anchor.message}`;
  if (report.valid) {
    console.log('Audit log integrity verified');
    console.log(`  Entries: ${chain.entries}`);
    console.log(`  Last hash: ${chain.lastHash.slice(0, 16)}...`);
    if (chain.verifiedFrom !== null) {
      console.log(
        chain.verifiedFrom > 1
          ? `  Sequence: ${chain.verifiedFrom} to ${chain.lastSeq} (verified from sequence ${chain.verifiedFrom}; earlier archives are not retained)`
          : `  Sequence: 1 to ${chain.lastSeq}`,
      );
    }
    console.log(`  ${anchorLine}`);
    return;
  }
  // A credential store that could not be read says nothing about the log either way.
  console.log(chain.valid && anchor.status === 'unreadable'
    ? 'Audit log not verified: the chain is intact, and the anchor could not be checked'
    : 'Audit log integrity FAILED');
  for (const error of chain.errors) console.log(`  - ${error}`);
  // The anchor is listed as a failure when it is one, and as a plain line when only the chain failed.
  const anchorPasses = ['matches', 'not_anchored', 'off', 'not_checked'].includes(anchor.status);
  console.log(anchorPasses ? `  ${anchorLine}` : `  - ${anchorLine}`);
  if (report.fix) console.log(`  → ${report.fix}`);
}

export async function auditVerifyCommand(options: { chainOnly?: boolean; json?: boolean }, deps: AuditCommandDeps): Promise<number> {
  const { report } = await verification(deps, options.chainOnly === true);
  if (options.json) {
    const { chain, anchor } = report;
    console.log(JSON.stringify({
      valid: report.valid,
      chain: {
        valid: chain.valid,
        errors: chain.errors,
        entries: chain.entries,
        last_seq: chain.lastSeq,
        last_hash: chain.lastHash,
        verified_from: chain.verifiedFrom,
      },
      anchor,
      ...(report.fix ? { fix: report.fix } : {}),
    }, null, 2));
  } else {
    printReport(report);
  }
  return report.valid ? 0 : 1;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Set the anchor to the log as it is. For a person whose log legitimately
 * differs from the anchor. It needs a terminal and a typed `yes`, and no
 * flag or variable answers for the person: the software that changed the log
 * must not be able to accept its own change by running a command.
 *
 * It runs only while no proxy is serving. A serving proxy holds the log's
 * position in memory and writes anchors of its own, and an endpoint that
 * reset them on request would be open to every process running as the user.
 */
export async function auditAcceptCommand(deps: AuditCommandDeps): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('aquaman audit accept needs a terminal: a person has to confirm it.');
    console.error('Run it yourself in a terminal window: aquaman audit accept');
    return 1;
  }
  if (await deps.proxyRunning()) {
    console.error('A proxy is running and holds the audit log open.');
    console.error('Stop it first (aquaman stop, or stop the OpenClaw gateway that started it), run aquaman audit accept, then start it again.');
    return 1;
  }

  let store: CredentialStore;
  try {
    store = await deps.openStore();
  } catch (err) {
    console.error(`Credential store not available: ${err instanceof Error ? err.message : err}`);
    console.error('Unlock or sign in to the credential backend and run this again. Run: aquaman doctor');
    return 1;
  }

  const { report, logger } = await verification({ ...deps, openStore: async () => store }, false);
  const { anchor, chain } = report;
  if (anchor.status === 'unreadable') {
    console.error(`Anchor: ${anchor.message}`);
    console.error(report.fix);
    return 1;
  }
  if (!chain.valid) {
    // Asked before the person is, so nobody confirms something that then cannot be done.
    console.error(`Not accepted: the chain itself is broken (${chain.errors[0]}), and accepting an anchor does not repair it.`);
    console.error('Move the audit directory aside (for example: mv ~/.aquaman/audit ~/.aquaman/audit.broken) so a new log starts, then run: aquaman audit accept');
    return 1;
  }
  if (anchor.status === 'matches' || anchor.status === 'not_anchored' || anchor.status === 'off') {
    console.log(`Nothing to accept. Anchor: ${anchor.message}`);
    return 0;
  }

  console.log(`Anchor: ${anchor.message}`);
  console.log(`The log now ends at sequence ${chain.lastSeq}.`);
  console.log('Accepting sets the anchor to the log as it is. Entries that were removed are no longer reported by aquaman audit verify.');
  const answer = await ask('Type yes to accept: ');
  if (answer.trim() !== 'yes') {
    console.log('Not accepted. The anchor is unchanged.');
    return 1;
  }

  const result = await acceptAuditLog({ logger, store });
  if (!result.accepted) {
    console.error(`Not accepted: ${result.reason}.`);
    console.error(result.fix);
    return 1;
  }
  console.log(`Accepted. The anchor is at sequence ${result.seq} (was ${result.previousSeq ?? 'unreadable'}), and the reset is recorded in the log.`);
  return 0;
}
