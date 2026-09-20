/**
 * Unit tests for broker-scope.ts (v0.15.0): ref parsing, declared-ref loading,
 * and the scope decision table. The HTTP-level guarantees live in
 * test/compliance/broker-scope.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseAquamanRef,
  formatAquamanRef,
  loadProjectRefs,
  createBrokerScope,
  defaultProjectsPath,
} from 'aquaman-proxy';
import { loadConfigAllowedRefs } from '../../packages/proxy/src/broker-scope.js';

describe('broker-scope', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-scope-unit-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  describe('refs', () => {
    it('parses aquaman://service/key with the daemon grammar', () => {
      expect(parseAquamanRef('aquaman://github/token')).toEqual({ service: 'github', key: 'token' });
      expect(parseAquamanRef('aquaman://aws/SECRET_ACCESS_KEY')).toEqual({ service: 'aws', key: 'SECRET_ACCESS_KEY' });
      for (const bad of ['aquaman://GitHub/token', 'aquaman://github', 'github/token', 'aquaman://../x/y', 'aquaman://a/b/c']) {
        expect(parseAquamanRef(bad)).toBeNull();
      }
      expect(formatAquamanRef('github', 'token')).toBe('aquaman://github/token');
    });

    it('defaults projects.yaml to the config dir (AQUAMAN_CONFIG_DIR-aware)', () => {
      const prev = process.env['AQUAMAN_CONFIG_DIR'];
      process.env['AQUAMAN_CONFIG_DIR'] = dir;
      try {
        expect(defaultProjectsPath()).toBe(path.join(dir, 'projects.yaml'));
      } finally {
        if (prev === undefined) delete process.env['AQUAMAN_CONFIG_DIR'];
        else process.env['AQUAMAN_CONFIG_DIR'] = prev;
      }
    });
  });

  describe('loadProjectRefs', () => {
    it('collects every valid env ref across projects and ignores the rest', () => {
      const p = path.join(dir, 'projects.yaml');
      fs.writeFileSync(p, [
        'version: 1',
        'projects:',
        '  a:',
        '    paths: ["/a"]',
        '    env:',
        '      GITHUB_TOKEN: aquaman://github/token',
        '      NOT_A_REF: plain-value',
        '  b:',
        '    paths: ["/b"]',
        '    env:',
        '      DB: aquaman://supabase/db_url',
        '      DUP: aquaman://github/token',
        '  c:',
        '    paths: ["/c"]',
      ].join('\n'));
      const r = loadProjectRefs(p);
      expect(r.error).toBeUndefined();
      expect([...r.refs].sort()).toEqual(['aquaman://github/token', 'aquaman://supabase/db_url']);
    });

    it('declares nothing for a missing file and reports a malformed one', () => {
      expect(loadProjectRefs(path.join(dir, 'missing.yaml'))).toEqual({ refs: new Set() });
      const p = path.join(dir, 'bad.yaml');
      fs.writeFileSync(p, 'projects: [\n');
      const r = loadProjectRefs(p);
      expect(r.refs.size).toBe(0);
      expect(r.error).toMatch(/cannot parse/);
    });
  });

  describe('loadConfigAllowedRefs', () => {
    it('reads broker.allowedRefs from the raw config file', () => {
      const p = path.join(dir, 'config.yaml');
      fs.writeFileSync(p, 'broker:\n  allowedRefs:\n    - aquaman://npm/token\n    - not-a-ref\n');
      expect([...loadConfigAllowedRefs(p).refs]).toEqual(['aquaman://npm/token']);
      expect(loadConfigAllowedRefs(path.join(dir, 'none.yaml')).refs.size).toBe(0);
    });
  });

  describe('createBrokerScope decisions', () => {
    it('allows declared refs, refuses undeclared, and denies the loopback tier first', () => {
      const scope = createBrokerScope({
        projectsPath: path.join(dir, 'projects.yaml'),
        allowedRefs: ['aquaman://github/token', 'aquaman://anthropic/api_key'],
        loopbackDeniedServices: ['anthropic', 'openai'],
      });
      expect(scope.check('github', 'token', 'uds')).toEqual({ allowed: true });
      expect(scope.check('github', 'token', 'loopback')).toEqual({ allowed: true });
      // Declared + UDS = an explicit coding-agent opt-in.
      expect(scope.check('anthropic', 'api_key', 'uds')).toEqual({ allowed: true });
      expect(scope.check('anthropic', 'api_key', 'loopback')).toMatchObject({ allowed: false, code: 'broker_ref_isolated' });
      expect(scope.check('openai', 'api_key', 'loopback')).toMatchObject({ allowed: false, code: 'broker_ref_isolated' });
      const denied = scope.check('slack', 'bot_token', 'uds');
      expect(denied).toMatchObject({ allowed: false, code: 'broker_ref_not_declared' });
      if (!denied.allowed) expect(denied.fix).toContain('aquaman broker allow aquaman://slack/bot_token');
    });

    it('lists declared refs with their source', () => {
      const projectsPath = path.join(dir, 'projects.yaml');
      const configPath = path.join(dir, 'config.yaml');
      fs.writeFileSync(projectsPath, 'projects:\n  a:\n    paths: ["/a"]\n    env:\n      X: aquaman://github/token\n');
      fs.writeFileSync(configPath, 'broker:\n  allowedRefs: [aquaman://npm/token]\n');
      const scope = createBrokerScope({ projectsPath, configPath });
      expect(scope.declared()).toEqual([
        { ref: 'aquaman://github/token', source: 'projects.yaml' },
        { ref: 'aquaman://npm/token', source: 'config.yaml' },
      ]);
      expect(scope.declarationError()).toBeUndefined();
    });

    it('surfaces declaration errors from either file', () => {
      const configPath = path.join(dir, 'config.yaml');
      fs.writeFileSync(configPath, 'broker: [\n');
      const scope = createBrokerScope({ projectsPath: path.join(dir, 'projects.yaml'), configPath });
      expect(scope.declarationError()).toMatch(/cannot parse .*config\.yaml/);
      const d = scope.check('npm', 'token', 'uds');
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toMatch(/cannot parse/);
    });
  });
});
