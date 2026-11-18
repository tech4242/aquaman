/**
 * A command that opens a KeePassXC vault exits when it is done.
 *
 * The backend watches its database file so a long-running process notices an
 * outside change. That watch must not keep a one-shot command alive: found
 * live, where `aquaman credentials list` and `aquaman audit verify` printed
 * their result and never returned.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSandbox, runCli, type Sandbox } from '../helpers/cov-cli-hosts.js';

const T = 60_000;
/** Far below the helper's kill timer: a command that hangs is killed and reports no exit code. */
const MUST_EXIT_WITHIN_MS = 25_000;

describe('commands on the keepassxc backend exit', () => {
  let sb: Sandbox;
  const env = () => ({ AQUAMAN_KEEPASS_PASSWORD: 'keepass-exit-test-password', AQUAMAN_BACKEND: undefined });

  beforeEach(() => {
    sb = createSandbox();
    fs.writeFileSync(path.join(sb.configDir, 'config.yaml'), [
      'credentials:',
      '  backend: keepassxc',
      `  keepassxcDatabasePath: ${path.join(sb.root, 'vault.kdbx')}`,
      '',
    ].join('\n'));
  });
  afterEach(async () => { await sb.cleanup(); });

  it('credentials add, list and delete each return, with the vault opened', async () => {
    const add = await runCli(sb, ['credentials', 'add', 'github', 'token'], { env: env(), input: 'ghp_keepass_exit_test_value\n', timeoutMs: MUST_EXIT_WITHIN_MS });
    expect(add.code, add.stderr).toBe(0);

    const list = await runCli(sb, ['credentials', 'list'], { env: env(), timeoutMs: MUST_EXIT_WITHIN_MS });
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain('github/token');

    const del = await runCli(sb, ['credentials', 'delete', 'github', 'token'], { env: env(), timeoutMs: MUST_EXIT_WITHIN_MS });
    expect(del.code, del.stderr).toBe(0);
  }, T * 2);

  it('audit verify returns after reading the anchor from the vault', async () => {
    const verify = await runCli(sb, ['audit', 'verify'], { env: env(), timeoutMs: MUST_EXIT_WITHIN_MS });
    expect(verify.code, verify.stderr + verify.stdout).toBe(0);
  }, T);
});
