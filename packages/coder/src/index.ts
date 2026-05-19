/**
 * aquaman-coder
 *
 * Vault adapter for AI coding agents (Claude Code, Codex, OpenCode, Cursor).
 *
 * This package is the user-facing layer for the v0.12.0 coding-agent pivot.
 * It depends on `aquaman-proxy` (the canonical core daemon) for vault access
 * via the `/broker/resolve` UDS endpoint, and ships per-agent hook adapters
 * + setup commands.
 *
 * v0.12.0-pre skeleton — implementation lands in subsequent commits:
 *   - src/broker/   broker client (talks to aquaman-proxy daemon)
 *   - src/projects/ ~/.aquaman/projects.yaml resolver
 *   - src/redactor/ secret-pattern redactor (AWS, GitHub, Stripe, ...)
 *   - src/adapters/claude-code/  hook handler + setup writer
 *   - src/cli/      `aquaman-coder` CLI entry point
 *
 * See docs/PACKAGES.md for the package boundary policy.
 */

export const VERSION = '0.12.0-pre.0';
