/**
 * Two real processes write one audit log at the same time while a third
 * reads it, as a daemon, an OpenClaw-hosted proxy and `aquaman audit verify`
 * do on one config directory. Afterwards the log is one chain: every entry
 * either process reported as written is there once, the sequence has no gap
 * and no repeat, and no read found the chain broken.
 *
 * The processes are test/helpers/audit-log-child.ts. They use a temporary
 * directory and nothing else.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger } from 'aquaman-core';

const CHILD = path.resolve(__dirname, '../helpers/audit-log-child.ts');

function run(role: 'writer' | 'reader', logDir: string, startAt: number, stopAt: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', CHILD, role, logDir, String(startAt), String(stopAt)], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${role} exited ${code}: ${stderr}`));
      resolve(JSON.parse(stdout.trim().split('\n').pop()!));
    });
  });
}

describe('two processes writing one audit log while a third reads it', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-procs-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ends with one valid chain, consecutive sequence numbers, every reported write on disk once, and no read that found it broken', async () => {
    // Time for three tsx processes to start; each waits for the same moment.
    const startAt = Date.now() + 6000;
    const stopAt = startAt + 1500;
    const [a, b, reader] = await Promise.all([
      run('writer', dir, startAt, stopAt),
      run('writer', dir, startAt, stopAt),
      run('reader', dir, startAt, stopAt),
    ]);

    expect(a.wrote).toBeGreaterThan(0);
    expect(b.wrote).toBeGreaterThan(0);
    expect(reader.reads).toBeGreaterThan(0);
    expect(reader.invalid).toEqual([]);

    const files = [
      ...fs.readdirSync(path.join(dir, 'archive')).sort().map((n) => path.join(dir, 'archive', n)),
      path.join(dir, 'current.jsonl'),
    ].filter((f) => fs.existsSync(f));
    const entries = files.flatMap((f) => fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));

    // No gap, no repeat, and nothing lost or written twice.
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: entries.length }, (_, i) => i + 1));
    expect(entries.length).toBe(a.wrote + b.wrote);
    // Both processes are in the one chain, and the log was rotated while they wrote.
    expect(new Set(entries.map((e) => e.sessionId)).size).toBe(2);
    expect(files.length).toBeGreaterThan(1);

    const check = await new AuditLogger({ logDir: dir, readOnly: true }).verifyChain();
    expect(check).toMatchObject({ valid: true, errors: [], lastSeq: entries.length, verifiedFrom: 1 });

    // Nothing is left behind: no lock, and an empty write-ahead file.
    expect(fs.existsSync(path.join(dir, 'write.lock'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'current.wal'), 'utf-8')).toBe('');
    expect(fs.readdirSync(dir).sort()).toEqual(['archive', 'current.jsonl', 'current.wal', 'integrity'].filter((n) => fs.existsSync(path.join(dir, n))));
  }, 90_000);
});
