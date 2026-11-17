/**
 * The prompts of `aquaman openclaw setup`, `aquaman setup` and
 * `aquaman openclaw migrate --auto` when a person is at a terminal: secrets
 * are read in raw mode, key by key, and never shown.
 *
 * A pseudo-terminal stands in for the person's terminal
 * (test/helpers/cov-cli-hosts-pty.py, Python's standard `pty` module). The
 * tests are skipped where there is no python3.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createSandbox, baseConfig, runCli, runCliOnTty, findPython3, TEST_PASSWORD, type Sandbox,
} from '../helpers/cov-cli-hosts.js';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';

const T = 120_000;
const ENTER = '\r';
const BACKSPACE = '\x7f';
const CTRL_C = '\x03';

describe.skipIf(!findPython3())('aquaman prompts on a terminal (cli-hosts coverage)', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = createSandbox(); });
  afterEach(() => { sb.cleanup(); });

  const vault = () => new EncryptedFileStore(TEST_PASSWORD, path.join(sb.configDir, 'credentials.enc'));

  it('openclaw setup: a typed key is stored, backspace edits it, Enter skips', async () => {
    const r = await runCliOnTty(sb, ['openclaw', 'setup', '--backend', 'encrypted-file'], [
      // "sk-ant-ttyX", one key rubbed out, then "9".
      ['? Enter your Anthropic API key: ', `sk-ant-ttyX${BACKSPACE}9${ENTER}`],
      ['? Enter your OpenAI API key (or press Enter to skip): ', ENTER],
      ['? Enable API request policies? (Y/n): ', `n${ENTER}`],
    ]);
    expect(r.output).toContain('✓ Stored anthropic/api_key');
    expect(r.output).toContain('Skipped');
    expect(r.output).toContain('Setup complete!');
    expect(r.code).toBe(0);

    expect(await vault().get('anthropic', 'api_key')).toBe('sk-ant-tty9');
    expect(await vault().get('openai', 'api_key')).toBeNull();
    expect(sb.readConfig()).not.toContain('policy:');
  }, T);

  it('openclaw setup: Ctrl+C at a key prompt exits 0 and stores nothing', async () => {
    const r = await runCliOnTty(sb, ['openclaw', 'setup', '--backend', 'encrypted-file'], [
      ['? Enter your Anthropic API key: ', `sk-ant-abandoned${CTRL_C}`],
    ]);
    expect(r.code).toBe(0);
    expect(r.output).not.toContain('Stored');
    expect(r.output).not.toContain('Setup complete');
    expect(fs.existsSync(path.join(sb.configDir, 'credentials.enc'))).toBe(false);
  }, T);

  it('openclaw setup --backend keepassxc: an emptied master password is refused, Ctrl+C leaves quietly', async () => {
    const r = await runCliOnTty(sb, ['openclaw', 'setup', '--backend', 'keepassxc'], [
      ['? KeePassXC master password: ', `pw${BACKSPACE}${BACKSPACE}${ENTER}`],
    ]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('KeePassXC backend requires a master password.');
    expect(fs.existsSync(path.join(sb.configDir, 'config.yaml'))).toBe(false);

    const cancelled = await runCliOnTty(sb, ['openclaw', 'setup', '--backend', 'keepassxc'], [
      ['? KeePassXC master password: ', `hunter2-master${CTRL_C}`],
    ]);
    expect(cancelled.code).toBe(0);
    expect(cancelled.output).not.toContain('requires a master password');
    expect(fs.existsSync(path.join(sb.configDir, 'config.yaml'))).toBe(false);
  }, T);

  it('aquaman setup: the vault wizard reads keys the same way', async () => {
    const r = await runCliOnTty(sb, ['setup', '--backend', 'encrypted-file'], [
      ['? Anthropic API key (or Enter to skip): ', ENTER],
      ['? OpenAI API key (or Enter to skip): ', `sk-oai-ttyy${BACKSPACE}7${ENTER}`],
    ]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('✓ openai/api_key');
    expect(r.output).not.toContain('✓ anthropic/api_key');
    expect(r.output).toContain('✓ Default policy presets applied.');
    expect(await vault().get('openai', 'api_key')).toBe('sk-oai-tty7');
    expect(await vault().get('anthropic', 'api_key')).toBeNull();

    const cancelled = await runCliOnTty(sb, ['setup', '--backend', 'encrypted-file'], [
      ['? Anthropic API key (or Enter to skip): ', `sk-ant-abandoned${CTRL_C}`],
    ]);
    expect(cancelled.code).toBe(0);
    expect(await vault().get('anthropic', 'api_key')).toBeNull();
  }, T);

  // What the terminal showed is what a person at the screen (or over their
  // shoulder) saw: the prompt, and nothing of what was typed after it.
  it('openclaw setup: a typed API key is not shown on the terminal', async () => {
    const r = await runCliOnTty(sb, ['openclaw', 'setup', '--backend', 'encrypted-file'], [
      ['? Enter your Anthropic API key: ', `sk-ant-secret${CTRL_C}`],
    ]);
    expect(r.output).toContain('? Enter your Anthropic API key: ');
    expect(r.output).not.toContain('sk-ant-secret');
  }, T);

  it('aquaman setup: a typed API key is not shown on the terminal', async () => {
    const r = await runCliOnTty(sb, ['setup', '--backend', 'encrypted-file'], [
      ['? Anthropic API key (or Enter to skip): ', `sk-ant-secret${CTRL_C}`],
    ]);
    expect(r.output).toContain('? Anthropic API key (or Enter to skip): ');
    expect(r.output).not.toContain('sk-ant-secret');
  }, T);

  it('openclaw setup --backend keepassxc: the master password is not shown on the terminal', async () => {
    const r = await runCliOnTty(sb, ['openclaw', 'setup', '--backend', 'keepassxc'], [
      ['? KeePassXC master password: ', `hunter2-master${CTRL_C}`],
    ]);
    expect(r.output).toContain('? KeePassXC master password: ');
    expect(r.output).not.toContain('hunter2-master');
  }, T);

  describe('openclaw migrate --auto', () => {
    const PLAIN = '123456:PLAIN-TELEGRAM-TOKEN';
    const seed = () => {
      sb.writeConfig(baseConfig(sb));
      return sb.writeOpenClawJson({ channels: { telegram: { accounts: { mybot: { botToken: PLAIN } } } } });
    };

    it('asks before migrating and does nothing on anything but y', async () => {
      const cfg = seed();
      const before = fs.readFileSync(cfg, 'utf-8');
      const r = await runCliOnTty(sb, ['openclaw', 'migrate', '--auto'], [
        ['Migrate these 1 credentials? (y/N): ', ENTER],
      ]);
      expect(r.code).toBe(0);
      expect(r.output).toContain('telegram/bot_token');
      expect(r.output).toContain('Aborted.');
      expect(r.output).not.toContain('Migrated');
      expect(r.output).not.toContain(PLAIN);
      expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
      expect(fs.existsSync(path.join(sb.configDir, 'credentials.enc'))).toBe(false);
    }, T);

    it('migrates on y, then removes the plaintext only when that is confirmed too', async () => {
      seed();
      const kept = await runCliOnTty(sb, ['openclaw', 'migrate', '--auto'], [
        ['Migrate these 1 credentials? (y/N): ', `y${ENTER}`],
        ['Remove plaintext originals? (y/N): ', `n${ENTER}`],
      ]);
      expect(kept.code).toBe(0);
      expect(kept.output).toContain('Migrated 1 credential');
      expect(kept.output).toContain('Cleanup — remove plaintext sources:');
      expect(await vault().get('telegram', 'bot_token')).toBe(PLAIN);
      expect(sb.readOpenClawJson().channels.telegram.accounts.mybot.botToken).toBe(PLAIN);

      const removed = await runCliOnTty(sb, ['openclaw', 'migrate', '--auto'], [
        ['Migrate these 1 credentials? (y/N): ', `Y${ENTER}`],
        ['Remove plaintext originals? (y/N): ', `y${ENTER}`],
      ]);
      expect(removed.code).toBe(0);
      expect(removed.output).not.toContain('Cleanup — remove plaintext sources:');
      expect(sb.readOpenClawJson().channels.telegram.accounts.mybot.botToken).toBe('aquaman-proxy-managed');
      expect(await vault().get('telegram', 'bot_token')).toBe(PLAIN);

      // Nothing left to find.
      const again = await runCli(sb, ['openclaw', 'migrate', '--auto']);
      expect(again.stdout).toContain('No plaintext credentials found. Nothing to migrate.');
    }, T);
  });
});
