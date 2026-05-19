/**
 * Unit tests for aquaman-coder's projects.yaml resolver.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadProjects,
  saveProjects,
  findProjectForCwd,
  parseRef,
} from 'aquaman-coder';

describe('aquaman-coder / projects.yaml', () => {
  let tmpDir: string;
  let projectsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-coder-test-'));
    projectsPath = path.join(tmpDir, 'projects.yaml');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  describe('loadProjects', () => {
    it('returns empty config when file does not exist', () => {
      const f = loadProjects(projectsPath);
      expect(f.projects).toEqual({});
    });

    it('parses a valid projects.yaml', () => {
      fs.writeFileSync(
        projectsPath,
        `version: 1
projects:
  my-app:
    paths:
      - /tmp/my-app
    env:
      ANTHROPIC_API_KEY: aquaman://anthropic/api_key
      GITHUB_TOKEN: aquaman://github/token
`,
      );
      const f = loadProjects(projectsPath);
      expect(Object.keys(f.projects)).toEqual(['my-app']);
      expect(f.projects['my-app'].env.ANTHROPIC_API_KEY).toBe('aquaman://anthropic/api_key');
    });

    it('rejects an invalid aquaman:// reference', () => {
      fs.writeFileSync(
        projectsPath,
        `projects:
  bad:
    paths: ["/tmp"]
    env:
      X: "not-an-aquaman-ref"
`,
      );
      expect(() => loadProjects(projectsPath)).toThrow(/invalid reference/);
    });

    it('rejects a project with no paths', () => {
      fs.writeFileSync(
        projectsPath,
        `projects:
  bad:
    paths: []
    env: {}
`,
      );
      expect(() => loadProjects(projectsPath)).toThrow(/no paths/);
    });
  });

  describe('saveProjects', () => {
    it('writes a valid YAML file at chmod 0o600', () => {
      saveProjects({
        version: 1,
        projects: {
          test: { paths: ['/tmp/test'], env: { X: 'aquaman://anthropic/api_key' } },
        },
      }, projectsPath);
      expect(fs.existsSync(projectsPath)).toBe(true);
      const mode = fs.statSync(projectsPath).mode & 0o777;
      expect(mode & 0o077).toBe(0);
      // Round-trip
      const f = loadProjects(projectsPath);
      expect(f.projects.test.env.X).toBe('aquaman://anthropic/api_key');
    });
  });

  describe('findProjectForCwd', () => {
    it('matches when cwd is exactly the declared path', () => {
      const file = {
        version: 1,
        projects: {
          a: { paths: ['/tmp/foo'], env: {} },
        },
      };
      const m = findProjectForCwd('/tmp/foo', file);
      expect(m?.name).toBe('a');
    });

    it('matches when cwd is inside the declared path', () => {
      const file = {
        version: 1,
        projects: {
          a: { paths: ['/tmp/foo'], env: {} },
        },
      };
      const m = findProjectForCwd('/tmp/foo/nested/dir', file);
      expect(m?.name).toBe('a');
    });

    it('longest-prefix wins for nested projects', () => {
      const file = {
        version: 1,
        projects: {
          outer: { paths: ['/tmp/foo'], env: {} },
          inner: { paths: ['/tmp/foo/bar'], env: {} },
        },
      };
      const m = findProjectForCwd('/tmp/foo/bar/baz', file);
      expect(m?.name).toBe('inner');
    });

    it('returns null when no project matches', () => {
      const file = {
        version: 1,
        projects: {
          a: { paths: ['/tmp/foo'], env: {} },
        },
      };
      expect(findProjectForCwd('/var/other', file)).toBeNull();
    });

    it('does not match a sibling that shares a prefix', () => {
      const file = {
        version: 1,
        projects: {
          a: { paths: ['/tmp/foo'], env: {} },
        },
      };
      expect(findProjectForCwd('/tmp/foobar', file)).toBeNull();
    });
  });

  describe('parseRef', () => {
    it('parses a valid reference', () => {
      expect(parseRef('aquaman://anthropic/api_key')).toEqual({
        service: 'anthropic',
        key: 'api_key',
      });
    });

    it('rejects malformed refs', () => {
      expect(parseRef('https://anthropic/api_key')).toBeNull();
      expect(parseRef('aquaman://Anthropic/api_key')).toBeNull(); // uppercase
      expect(parseRef('aquaman://anthropic')).toBeNull(); // no key
      expect(parseRef('aquaman://anthropic/api_key/extra')).toBeNull();
    });
  });
});
