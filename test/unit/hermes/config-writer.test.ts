/**
 * Unit tests for the Hermes config-writer (v0.13.0+)
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  generateHermesEnv,
  hermesWiredServices,
  getHermesEnvPath,
  writeHermesEnv,
} from 'aquaman-proxy';

describe('generateHermesEnv', () => {
  const opts = { port: 8585, token: 'aqm_lb_tok', host: '127.0.0.1' };

  it('maps anthropic to /anthropic (no /v1) + placeholder key', () => {
    const env = generateHermesEnv({ ...opts, services: ['anthropic'] });
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:8585/anthropic');
    expect(env['ANTHROPIC_API_KEY']).toBe('aqm_lb_tok');
  });

  it('maps openai to /openai/v1 + placeholder key', () => {
    const env = generateHermesEnv({ ...opts, services: ['openai'] });
    expect(env['OPENAI_BASE_URL']).toBe('http://127.0.0.1:8585/openai/v1');
    expect(env['OPENAI_API_KEY']).toBe('aqm_lb_tok');
  });

  it('ignores unsupported services (channels/other providers)', () => {
    const env = generateHermesEnv({ ...opts, services: ['slack', 'telegram', 'github'] });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it('honors a custom host', () => {
    const env = generateHermesEnv({ port: 9000, token: 't', host: '127.0.0.2', services: ['anthropic'] });
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.2:9000/anthropic');
  });

  it('defaults host to 127.0.0.1', () => {
    const env = generateHermesEnv({ port: 9000, token: 't', services: ['anthropic'] });
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:9000/anthropic');
  });
});

describe('hermesWiredServices', () => {
  it('returns only anthropic/openai from a mixed list', () => {
    expect(hermesWiredServices(['anthropic', 'slack', 'openai', 'github'])).toEqual(['anthropic', 'openai']);
  });

  it('returns empty when no supported services present', () => {
    expect(hermesWiredServices(['slack', 'discord'])).toEqual([]);
  });
});

describe('getHermesEnvPath', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k];
    Object.assign(process.env, original);
  });

  it('defaults to ~/.hermes/.env', () => {
    delete process.env['HERMES_STATE_DIR'];
    delete process.env['HERMES_HOME'];
    expect(getHermesEnvPath('/home/me')).toBe(path.join('/home/me', '.hermes', '.env'));
  });

  it('honors HERMES_STATE_DIR override', () => {
    process.env['HERMES_STATE_DIR'] = '/custom/hermes';
    expect(getHermesEnvPath('/home/me')).toBe(path.join('/custom/hermes', '.env'));
  });
});

describe('writeHermesEnv', () => {
  let dir: string;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function mkTmp(): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-hermes-'));
    return path.join(dir, '.env');
  }

  it('writes a delimited aquaman block with mode 0o600', () => {
    const file = mkTmp();
    writeHermesEnv({ ANTHROPIC_BASE_URL: 'http://x/anthropic', ANTHROPIC_API_KEY: 'tok' }, file);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('# >>> aquaman managed >>>');
    expect(content).toContain('ANTHROPIC_BASE_URL=http://x/anthropic');
    expect(content).toContain('# <<< aquaman managed <<<');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('preserves pre-existing non-aquaman lines', () => {
    const file = mkTmp();
    fs.writeFileSync(file, 'EXISTING_VAR=keepme\n');
    writeHermesEnv({ ANTHROPIC_API_KEY: 'tok' }, file);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('EXISTING_VAR=keepme');
    expect(content).toContain('ANTHROPIC_API_KEY=tok');
  });

  it('is idempotent — re-running replaces the block, not appends', () => {
    const file = mkTmp();
    writeHermesEnv({ ANTHROPIC_API_KEY: 'tok1' }, file);
    writeHermesEnv({ ANTHROPIC_API_KEY: 'tok2' }, file);
    const content = fs.readFileSync(file, 'utf-8');
    const blockCount = (content.match(/# >>> aquaman managed >>>/g) || []).length;
    expect(blockCount).toBe(1);
    expect(content).toContain('ANTHROPIC_API_KEY=tok2');
    expect(content).not.toContain('ANTHROPIC_API_KEY=tok1');
  });
});
