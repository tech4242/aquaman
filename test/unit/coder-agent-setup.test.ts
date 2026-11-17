/**
 * What `aquaman init --agent` leaves in a project and in the agent's home so
 * later sessions keep using aquaman: the instructions block and the skill.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeAgentsBlock, installSkill, skillPath, agentsFileName, agentsBlock, AGENTS_BLOCK, SKILL_MD, SKILL_NAME } from 'aquaman-coder';

describe('agent setup', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-agent-setup-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  describe('instructions block', () => {
    it('uses CLAUDE.md for Claude Code and AGENTS.md for Codex', () => {
      expect(agentsFileName('claude-code')).toBe('CLAUDE.md');
      expect(agentsFileName('codex')).toBe('AGENTS.md');
    });

    it('creates the file when there is none', () => {
      const r = writeAgentsBlock('codex', dir);
      expect(r).toEqual({ path: path.join(dir, 'AGENTS.md'), action: 'created' });
      expect(fs.readFileSync(r.path, 'utf-8')).toBe(AGENTS_BLOCK);
    });

    it('appends to an existing file without touching what is there, and only once', () => {
      const file = path.join(dir, 'CLAUDE.md');
      const original = '# My project\n\nRun `make test` before committing.';
      fs.writeFileSync(file, original);
      expect(writeAgentsBlock('claude-code', dir).action).toBe('added');
      const after = fs.readFileSync(file, 'utf-8');
      expect(after.startsWith(original + '\n\n')).toBe(true);
      expect(after.endsWith(AGENTS_BLOCK)).toBe(true);
      expect(writeAgentsBlock('claude-code', dir).action).toBe('unchanged');
      expect(fs.readFileSync(file, 'utf-8')).toBe(after);
    });

    it('refuses to write through a link, so the block cannot land outside the project', () => {
      const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-outside-')), 'target.md');
      fs.writeFileSync(outside, 'someone else\'s file\n');
      fs.symlinkSync(outside, path.join(dir, 'CLAUDE.md'));
      expect(() => writeAgentsBlock('claude-code', dir)).toThrow(/not a regular file/);
      expect(fs.readFileSync(outside, 'utf-8')).toBe('someone else\'s file\n');
      fs.rmSync(path.dirname(outside), { recursive: true, force: true });
    });

    it('replaces an older block in place and keeps the text around it', () => {
      const file = path.join(dir, 'AGENTS.md');
      fs.writeFileSync(file, '# Top\n\n<!-- aquaman:start -->\nold text\n<!-- aquaman:end -->\n\n## Below\nkeep me\n');
      expect(writeAgentsBlock('codex', dir).action).toBe('updated');
      const after = fs.readFileSync(file, 'utf-8');
      expect(after).toBe(`# Top\n\n${AGENTS_BLOCK}\n## Below\nkeep me\n`);
      expect(after).not.toContain('old text');
    });

    it('tells the agent how to ask and what not to do, without any secret-shaped text', () => {
      expect(AGENTS_BLOCK).toContain('aquaman request aquaman://<service>/<key> --env <ENV_NAME> --json');
      expect(AGENTS_BLOCK).toContain('.env');
    });
  });

  describe('run mode', () => {
    it('the exec block tells the agent to prefix commands and never claims they are injected already', () => {
      const r = writeAgentsBlock('claude-code', dir, 'exec');
      const text = fs.readFileSync(r.path, 'utf-8');
      expect(text).toBe(agentsBlock('exec'));
      expect(text).toContain('aquaman-coder exec -- <command>');
      expect(text).not.toContain('already have its variables injected');
    });

    it('a later run in the other mode replaces the block', () => {
      writeAgentsBlock('claude-code', dir, 'exec');
      expect(writeAgentsBlock('claude-code', dir, 'hook').action).toBe('updated');
      expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe(AGENTS_BLOCK);
    });

    it('the skill explains both modes and names the form that changes no host setting', () => {
      expect(SKILL_MD).toContain('aquaman-coder exec -- <command>');
      expect(SKILL_MD).toContain('--no-hooks');
      expect(SKILL_MD).toMatch(/Ask the user before choosing it/);
    });
  });

  describe('skill', () => {
    it('goes where each agent loads personal skills from', () => {
      expect(skillPath('claude-code', dir)).toBe(path.join(dir, '.claude', 'skills', SKILL_NAME, 'SKILL.md'));
      expect(skillPath('codex', dir)).toBe(path.join(dir, '.agents', 'skills', SKILL_NAME, 'SKILL.md'));
    });

    it('is written once and left alone when current', () => {
      expect(installSkill('codex', dir).changed).toBe(true);
      expect(installSkill('codex', dir).changed).toBe(false);
      expect(fs.readFileSync(skillPath('codex', dir), 'utf-8')).toBe(SKILL_MD);
    });

    // Codex refuses a skill without `name` (64 characters at most) and
    // `description`; Claude Code needs `description` to know when to use it.
    it('has the frontmatter both hosts require', () => {
      const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(SKILL_MD);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(SKILL_NAME);
      expect(m![1].length).toBeLessThanOrEqual(64);
      expect(m![2]).toMatch(/API key/);
      expect(m![2]).toMatch(/\.env/);
    });

    it('documents every status `aquaman request` can return', () => {
      for (const status of ['ready', 'stored', 'approved', 'declined', 'pending', 'error']) {
        expect(SKILL_MD).toContain(`\`${status}\``);
      }
    });
  });
});
