/**
 * E2E: the vault-level commands of the proxy CLI that need no daemon:
 * `credentials` (add, list, delete, guide), `services` (list, validate),
 * `broker` (list, allow, revoke) and `audit` (tail, verify, rotate).
 *
 * Each refusal is checked for its exit code and for the line that tells the
 * user what to do next.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createAuditLogger } from 'aquaman-core';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { createSandbox, PASSWORD, T, type Sandbox } from './cov-cli-core-helpers.js';

describe('cli-core: credentials, services, broker and audit commands', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = createSandbox(); });
  afterEach(async () => { await sb.cleanup(); });

  const vault = () => new EncryptedFileStore(PASSWORD, path.join(sb.config, 'credentials.enc'));
  const rawConfig = () => parseYaml(fs.readFileSync(path.join(sb.config, 'config.yaml'), 'utf-8'));

  describe('credentials', () => {
    it('add refuses a service or key name outside the safe alphabet, before reading any value', async () => {
      const badService = await sb.run(['credentials', 'add', 'Git Hub', 'token'], { input: 'ghp_never_stored' });
      expect(badService.code).toBe(1);
      expect(badService.stderr).toContain('Invalid service: "Git Hub"');
      expect(badService.stderr).toContain('lowercase alphanumeric');

      const badKey = await sb.run(['credentials', 'add', 'github', '../token'], { input: 'ghp_never_stored' });
      expect(badKey.code).toBe(1);
      expect(badKey.stderr).toContain('Invalid key: "../token"');
      expect(fs.existsSync(path.join(sb.config, 'credentials.enc'))).toBe(false);
    }, T);

    it('add rejects an empty value and stores nothing', async () => {
      const r = await sb.run(['credentials', 'add', 'github', 'token'], { input: '' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Empty credential value rejected');
      expect(await vault().list()).toEqual([]);
    }, T);

    it('add reports a backend that cannot be opened, with the reason', async () => {
      const r = await sb.run(['credentials', 'add', 'github', 'token', '--backend', 'vault'], { input: 'ghp_never_stored' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Credential store not available:');
      expect(r.stderr).toContain('vaultAddress required');
      expect(r.stdout).not.toContain('Credential stored');
    }, T);

    it('list shows nothing, then what add stored; delete removes it and says when there was nothing to remove', async () => {
      const empty = await sb.run(['credentials', 'list']);
      expect(empty.code).toBe(0);
      expect(empty.stdout.trim()).toBe('No credentials stored.');

      const added = await sb.run(['credentials', 'add', 'github', 'token'], { input: 'ghp_cov_cli_core_value\n' });
      expect(added.code).toBe(0);
      expect(added.stdout).toContain('Credential stored: github/token');
      expect(await vault().get('github', 'token')).toBe('ghp_cov_cli_core_value');

      const listed = await sb.run(['credentials', 'list']);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain('Stored credentials:');
      expect(listed.stdout).toContain('  github/token');
      expect(listed.stdout).not.toContain('ghp_cov_cli_core_value');

      const deleted = await sb.run(['credentials', 'delete', 'github', 'token']);
      expect(deleted.code).toBe(0);
      expect(deleted.stdout).toContain('Credential deleted: github/token');
      expect(await vault().get('github', 'token')).toBeNull();

      const again = await sb.run(['credentials', 'delete', 'github', 'token']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('Credential not found: github/token');
    }, T * 2);

    it('delete validates names, and list and delete fail with exit 1 when the backend cannot be opened', async () => {
      const bad = await sb.run(['credentials', 'delete', 'github', 'TOKEN']);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('Invalid key: "TOKEN"');

      const list = await sb.run(['credentials', 'list'], { env: { AQUAMAN_BACKEND: 'vault' } });
      expect(list.code).toBe(1);
      expect(list.stderr).toContain('Credential store not available.');

      const del = await sb.run(['credentials', 'delete', 'github', 'token'], { env: { AQUAMAN_BACKEND: 'vault' } });
      expect(del.code).toBe(1);
      expect(del.stderr).toContain('Credential store not available.');
      expect(del.stdout).not.toContain('Credential deleted');
    }, T * 2);

    it('guide prints one add command per credential key, for every proxied service', async () => {
      sb.writeConfig('credentials:\n  backend: encrypted-file\n  proxiedServices: [anthropic, twilio, twitch, not-a-service]\n');
      const r = await sb.run(['credentials', 'guide']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Credential setup guide (backend: encrypted-file)');
      expect(r.stdout).toContain('  aquaman credentials add anthropic api_key');
      // Twilio needs two keys (additionalCredentialKeys), Twitch two (additionalHeaders).
      expect(r.stdout).toMatch(/twilio \(.*\):\n {2}\[multi-credential service: 2 keys required\]\n {2}aquaman credentials add twilio account_sid\n {2}aquaman credentials add twilio auth_token/);
      expect(r.stdout).toMatch(/twitch \(.*\):\n {2}\[multi-credential service: 2 keys required\]/);
      expect(r.stdout).toContain('  aquaman credentials add twitch client_id');
      // A proxied name with no definition is skipped rather than guessed at.
      expect(r.stdout).not.toContain('not-a-service');
    }, T);

    it('guide --backend vault prints vault commands, --backend 1password the add command, and --service narrows it', async () => {
      const v = await sb.run(['credentials', 'guide', '--backend', 'vault', '--service', 'github']);
      expect(v.code).toBe(0);
      expect(v.stdout).toContain('Credential setup guide (backend: vault)');
      expect(v.stdout).toContain('  vault kv put secret/aquaman/github/token credential="YOUR_KEY"');
      expect(v.stdout).not.toContain('anthropic');

      const op = await sb.run(['credentials', 'guide', '--backend', '1password', '--service', 'github']);
      expect(op.code).toBe(0);
      expect(op.stdout).toContain('  aquaman credentials add github token');

      const unknown = await sb.run(['credentials', 'guide', '--service', 'acme']);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('Unknown service: acme');
      expect(unknown.stdout).toBe('');
    }, T * 2);
  });

  describe('services', () => {
    const custom = [
      'services:',
      '  - name: acme',
      '    upstream: https://api.acme.test',
      '    authHeader: Authorization',
      '    authPrefix: "Bearer "',
      '    credentialKey: api_key',
      '    description: Acme test API',
      '',
    ].join('\n');

    it('list shows builtin and custom services with their source, and filters either way', async () => {
      const none = await sb.run(['services', 'list', '--custom']);
      expect(none.code).toBe(0);
      expect(none.stdout.trim()).toBe('No services found.');

      fs.writeFileSync(path.join(sb.config, 'services.yaml'), custom);
      const all = await sb.run(['services', 'list']);
      expect(all.code).toBe(0);
      expect(all.stdout).toContain('Configured services:');
      expect(all.stdout).toContain('  anthropic (builtin)');
      expect(all.stdout).toContain('  acme (custom)\n    Upstream: https://api.acme.test\n    Auth: Authorization (prefix: "Bearer ")\n    Credential key: api_key\n    Description: Acme test API');

      const onlyCustom = await sb.run(['services', 'list', '--custom']);
      expect(onlyCustom.stdout).toContain('  acme (custom)');
      expect(onlyCustom.stdout).not.toContain('(builtin)');

      const onlyBuiltin = await sb.run(['services', 'list', '--builtin']);
      expect(onlyBuiltin.stdout).toContain('  github (builtin)');
      expect(onlyBuiltin.stdout).not.toContain('acme');
    }, T * 2);

    it('validate explains how to create the file when there is none', async () => {
      const r = await sb.run(['services', 'validate']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`No services file found at ${path.join(sb.config, 'services.yaml')}`);
      expect(r.stdout).toContain('To create a custom services file:');
      expect(r.stdout).toContain('    credentialKey: api_key');
    }, T);

    it('validate accepts a good file and counts its services, and fails with each error on a bad one', async () => {
      const good = path.join(sb.root, 'good.yaml');
      fs.writeFileSync(good, custom);
      const ok = await sb.run(['services', 'validate', '--path', good]);
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain(`${good} is valid`);
      expect(ok.stdout).toMatch(/Found \d+ services/);

      const bad = path.join(sb.root, 'bad.yaml');
      // A builtin name must not be redefinable: that would redirect a real credential.
      fs.writeFileSync(bad, custom.replace('name: acme', 'name: anthropic'));
      const failed = await sb.run(['services', 'validate', '-p', bad]);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toContain(`${bad} has errors:`);
      expect(failed.stdout).toContain('  - Service 1: cannot override builtin service "anthropic"');
    }, T * 2);
  });

  describe('broker', () => {
    it('list says so when nothing is declared, and names the two places refs come from', async () => {
      const r = await sb.run(['broker', 'list']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('served by `aquaman daemon` only');
      expect(r.stdout).toContain('No declared refs — every broker request is refused.');
      expect(r.stdout).toContain('Never over the loopback listener: ');
      expect(r.stdout).toContain(`Coding-agent refs: ${path.join(sb.config, 'projects.yaml')}`);
      expect(r.stdout).toContain(`broker.allowedRefs in ${path.join(sb.config, 'config.yaml')}`);
    }, T);

    it('allow writes sorted refs to the raw config, list shows each with its source, revoke removes one', async () => {
      const allowed = await sb.run(['broker', 'allow', 'aquaman://stripe/secret_key', 'aquaman://github/token']);
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toContain('Allowed: aquaman://stripe/secret_key');
      expect(allowed.stdout).toContain('Allowed: aquaman://github/token');
      expect(allowed.stdout).toContain('Any process running as you can now fetch these values');
      expect(rawConfig().broker.allowedRefs).toEqual(['aquaman://github/token', 'aquaman://stripe/secret_key']);
      // The file was edited raw: nothing from the environment was written into it.
      expect(fs.readFileSync(path.join(sb.config, 'config.yaml'), 'utf-8')).not.toContain(PASSWORD);

      fs.writeFileSync(path.join(sb.config, 'projects.yaml'), `projects:\n  app:\n    paths: [${sb.project}]\n    env:\n      NPM_TOKEN: aquaman://npm/token\n`);
      const listed = await sb.run(['broker', 'list']);
      expect(listed.stdout).toContain('  aquaman://npm/token  (projects.yaml)');
      expect(listed.stdout).toContain('  aquaman://github/token  (config.yaml)');
      expect(listed.stdout).toContain('  aquaman://stripe/secret_key  (config.yaml)');
      expect(listed.stdout).not.toContain('No declared refs');

      const revoked = await sb.run(['broker', 'revoke', 'aquaman://stripe/secret_key']);
      expect(revoked.code).toBe(0);
      expect(revoked.stdout).toContain('Revoked: aquaman://stripe/secret_key');
      expect(revoked.stdout).not.toContain('Any process running as you');
      expect(rawConfig().broker.allowedRefs).toEqual(['aquaman://github/token']);
    }, T * 2);

    it('allow and revoke refuse anything that is not an aquaman:// ref and leave the config alone', async () => {
      const one = await sb.run(['broker', 'allow', 'github/token']);
      expect(one.code).toBe(1);
      expect(one.stderr).toContain('Invalid ref: github/token');
      expect(one.stderr).toContain('Refs look like aquaman://<service>/<key>');

      const two = await sb.run(['broker', 'revoke', 'github/token', 'aquaman://github/token', 'https://github.com/x']);
      expect(two.code).toBe(1);
      expect(two.stderr).toContain('Invalid refs: github/token, https://github.com/x');
      expect(fs.existsSync(path.join(sb.config, 'config.yaml'))).toBe(false);
    }, T * 2);

    it('with broker.enabled false, allow still records the ref but says the broker is off, and list says disabled', async () => {
      sb.writeConfig('broker:\n  enabled: false\n');
      const allowed = await sb.run(['broker', 'allow', 'aquaman://github/token']);
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toContain('Note: broker.enabled is false in config.yaml, so the broker is off regardless.');
      expect(rawConfig().broker).toEqual({ enabled: false, allowedRefs: ['aquaman://github/token'] });

      const listed = await sb.run(['broker', 'list']);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain('Disabled (broker.enabled: false in config.yaml)');
      expect(listed.stdout).not.toContain('aquaman://github/token');
    }, T * 2);

    it('list warns when a declaring file does not parse', async () => {
      fs.writeFileSync(path.join(sb.config, 'projects.yaml'), 'projects: [unclosed\n');
      const r = await sb.run(['broker', 'list']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`⚠ cannot parse ${path.join(sb.config, 'projects.yaml')}`);
      expect(r.stdout).toContain('— refs declared there are refused until it parses');
      expect(r.stdout).toContain('No declared refs');
    }, T);
  });

  describe('audit', () => {
    const auditDir = () => path.join(sb.config, 'audit');
    const logFile = () => path.join(auditDir(), 'current.jsonl');

    async function seed(): Promise<void> {
      const logger = createAuditLogger({ logDir: auditDir(), enabled: true });
      await logger.initialize();
      await logger.logToolCall('s1', 'agent', 'Bash', { command: 'gh pr list' });
      await logger.logToolResult('s1', 'agent', 'call-42', { ok: true });
      await logger.logCredentialAccess('s1', 'agent', { service: 'github', operation: 'use', success: true });
      await logger.logCredentialAccess('s1', 'agent', { service: 'stripe', operation: 'read', success: false, error: 'not declared' });
      await logger.logCredentialAccess('s1', 'agent', { service: 'slack', operation: 'use', success: false });
    }

    it('tail says when the log is empty', async () => {
      const r = await sb.run(['audit', 'tail']);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('No audit entries found.');
    }, T);

    it('tail prints one line per entry, formatted by entry type, newest last, and honours -n', async () => {
      await seed();
      // A type this version does not know is still shown, as its data.
      fs.appendFileSync(logFile(), JSON.stringify({ id: 'x', timestamp: new Date().toISOString(), type: 'future_event', sessionId: 's1', agentId: 'agent', data: { note: 'hello' }, previousHash: 'p', hash: 'h' }) + '\n');

      const r = await sb.run(['audit', 'tail']);
      expect(r.code).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines).toHaveLength(6);
      expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[TOOL_CALL {7}\] Bash \{"command":"gh pr list"\}$/);
      expect(lines[1]).toMatch(/\[TOOL_RESULT {5}\] Result for call-42$/);
      expect(lines[2]).toMatch(/\[CREDENTIAL_ACCESS\] github use OK$/);
      expect(lines[3]).toMatch(/\[CREDENTIAL_ACCESS\] stripe read FAIL: not declared$/);
      expect(lines[4]).toMatch(/\[CREDENTIAL_ACCESS\] slack use FAIL: unknown$/);
      expect(lines[5]).toMatch(/\[FUTURE_EVENT {4}\] \{"note":"hello"\}$/);

      const two = await sb.run(['audit', 'tail', '-n', '2']);
      const last = two.stdout.trim().split('\n');
      expect(last).toHaveLength(2);
      expect(last[0]).toContain('slack use FAIL');
    }, T * 2);

    it('verify passes an intact chain with its entry count, and fails with exit 1 once a line is altered', async () => {
      await seed();
      const ok = await sb.run(['audit', 'verify']);
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain('Audit log integrity verified');
      expect(ok.stdout).toContain('  Entries: 5');
      expect(ok.stdout).toMatch(/Last hash: [0-9a-f]{16}\.\.\./);

      fs.writeFileSync(logFile(), fs.readFileSync(logFile(), 'utf-8').replace('"github"', '"gitlab"'));
      const tampered = await sb.run(['audit', 'verify']);
      expect(tampered.code).toBe(1);
      expect(tampered.stdout).toContain('Audit log integrity FAILED');
      expect(tampered.stdout).toMatch(/ {2}- Entry 2: hash mismatch/);
      expect(tampered.stdout).not.toContain('integrity verified');
    }, T * 2);

    it('rotate moves the log into the archive, and fails with exit 1 when there is no log', async () => {
      const nothing = await sb.run(['audit', 'rotate']);
      expect(nothing.code).toBe(1);
      expect(nothing.stderr).toContain('Failed to rotate log:');
      expect(nothing.stderr).toContain('No log file to rotate');

      await seed();
      const before = fs.readFileSync(logFile(), 'utf-8');
      const r = await sb.run(['audit', 'rotate']);
      expect(r.code).toBe(0);
      const archive = r.stdout.match(/Log rotated to: (.+)/)?.[1].trim();
      expect(archive).toBeTruthy();
      expect(path.dirname(archive!)).toBe(path.join(auditDir(), 'archive'));
      expect(fs.readFileSync(archive!, 'utf-8')).toBe(before);
      expect(fs.existsSync(logFile())).toBe(false);
    }, T * 2);
  });
});
