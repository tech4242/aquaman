#!/usr/bin/env node
/**
 * Minimal stand-in for Keeper Commander, emulating only what the aquaman
 * Keeper backend uses (behavior read from Commander v18.1.5 source):
 *   keeper --batch-mode [--config F] get <UID> --format json|password
 *   keeper --batch-mode [--config F] rm -f <UID>
 *   keeper --batch-mode [--config F] -      (commands on stdin, stops at `q`,
 *                                            exits 1 on the first failure)
 * State lives in $FAKE_KEEPER_STATE (JSON). Every argv is appended to
 * $FAKE_KEEPER_ARGV_LOG so tests can assert no secret reached argv.
 * $FAKE_KEEPER_LOGGED_OUT=1 simulates a lapsed persistent login: the process
 * fails, and in stdin mode it "reads the first line as the email" and logs it.
 */
import * as fs from 'node:fs';

const statePath = process.env.FAKE_KEEPER_STATE;
const argvLog = process.env.FAKE_KEEPER_ARGV_LOG;
const args = process.argv.slice(2);
if (argvLog) fs.appendFileSync(argvLog, JSON.stringify(args) + '\n');

const load = () => JSON.parse(fs.readFileSync(statePath, 'utf-8'));
const save = (s) => fs.writeFileSync(statePath, JSON.stringify(s));

// Strip global options.
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--batch-mode') continue;
  if (args[i] === '--config') { i++; continue; }
  rest.push(args[i]);
}

function shlexSplit(line) {
  const out = []; let cur = ''; let q = null; let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') { if (c === '"') q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

function decodeValue(v) {
  if (v.startsWith('$BASE64:')) return Buffer.from(v.slice(8), 'base64').toString('utf-8');
  if (v.startsWith('$GEN') || v.startsWith('$JSON')) return '<MACRO:' + v + '>';
  return v;
}

function fieldValue(tokens) {
  for (const t of tokens) {
    // Commander folds a leading '=' in the value into the field name.
    const m = /^password=(?!=)(.*)$/s.exec(t);
    if (m) return decodeValue(m[1]);
  }
  throw new Error('no password field');
}

function execLine(line) {
  const t = shlexSplit(line);
  const s = load();
  if (t[0] === 'record-add') {
    const folder = (t.find((x) => x.startsWith('--folder=')) || '').slice(9);
    const title = t[t.indexOf('-t') + 1];
    if (!s.folders[folder]) throw new Error('folder not found');
    const uid = 'rec' + String(Object.keys(s.records).length + 1).padStart(19, '0');
    s.records[uid] = { title, password: fieldValue(t), folder };
  } else if (t[0] === 'record-update') {
    const uid = t[t.indexOf('-r') + 1];
    if (!s.records[uid]) throw new Error('record not found');
    s.records[uid].password = fieldValue(t);
  } else {
    throw new Error('unsupported: ' + t[0]);
  }
  save(s);
}

if (process.env.FAKE_KEEPER_LOGGED_OUT === '1') {
  if (rest[0] === '-') {
    const first = fs.readFileSync(0, 'utf-8').split('\n')[0];
    fs.appendFileSync(process.env.FAKE_KEEPER_LEAK_LOG, first + '\n');
  }
  process.stderr.write('Not logged in\n');
  process.exit(1);
}

try {
  if (rest[0] === '-') {
    const lines = fs.readFileSync(0, 'utf-8').split('\n');
    for (const line of lines) {
      if (line.trim() === 'q') break;
      if (line.trim()) execLine(line);
    }
  } else if (rest[0] === 'get') {
    const [, uid, , fmt] = rest;
    const s = load();
    if (s.folders[uid]) {
      const records = Object.entries(s.records)
        .filter(([, r]) => r.folder === uid)
        .map(([record_uid, r]) => ({ record_uid, record_name: r.title }));
      process.stdout.write(JSON.stringify({ folder_uid: uid, records }, null, 2) + '\n');
    } else if (s.records[uid] && fmt === 'password') {
      process.stdout.write(s.records[uid].password + '\n');
    } else {
      throw new Error('not found');
    }
  } else if (rest[0] === 'rm') {
    const uid = rest[rest.length - 1];
    const s = load();
    delete s.records[uid];
    save(s);
  } else {
    throw new Error('unsupported command');
  }
} catch (e) {
  process.stderr.write(String(e.message) + '\n');
  process.exit(1);
}
