#!/usr/bin/env node
/**
 * aquaman-coder CLI entry point.
 *
 * v0.12.0-pre placeholder — full CLI lands in subsequent v0.12.0 commits.
 * Subcommands planned: setup <agent>, project <verb>, get <key>, exec <cmd>,
 * hook --target <agent>, doctor.
 */

import { VERSION } from '../index.js';

const args = process.argv.slice(2);

if (args[0] === '--version' || args[0] === '-V') {
  console.log(VERSION);
  process.exit(0);
}

console.log(`aquaman-coder ${VERSION}`);
console.log('');
console.log('  Vault adapter for AI coding agents.');
console.log('');
console.log('  This is a v0.12.0-pre skeleton — full CLI not yet implemented.');
console.log('  Track v0.12.0 progress in ROADMAP.md or the GitHub release branch.');
console.log('');
process.exit(0);
