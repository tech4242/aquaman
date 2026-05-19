# Package boundaries — the rules we follow

Aquaman is a monorepo with three packages. Each has a sharp, named role. We keep them separate to maintain scanner-stable boundaries, allow independent versioning when needed, and avoid the "shared stuff with no clear role" failure mode that killed the original `packages/core`.

## packages/proxy — `aquaman-proxy` on npm

**Role:** the canonical slim core daemon.

**Owns:**
- Vault backend abstraction + 7 backend implementations (Keychain, 1Password, HashiCorp Vault, KeePassXC, encrypted-file, systemd-creds, Bitwarden) — `src/core/credentials/`
- Hash-chained tamper-evident audit log — `src/core/audit/`
- HTTP/UDS proxy daemon with credential header injection — `src/daemon.ts`
- Service registry (builtin service definitions) — `src/service-registry.ts`
- Request policy engine — `src/request-policy.ts`
- Broker endpoint (`POST /broker/resolve`, v0.12.0+) — `src/broker/`
- Base CLI: `init`, `daemon`, `status`, `doctor`, `credentials`, `audit`, `policy`, `migrate`, `compliance check` — `src/cli/`

**Does not know about:** OpenClaw, Claude Code, Codex, OpenCode, Cursor, or any other specific agent / runtime. If a feature only makes sense for one ecosystem, **it does not belong here**.

**Transitional exception (v0.12.0):** OpenClaw-aware helpers in `src/openclaw/` and the OpenClaw-aware branches in the proxy CLI (`start`, `configure`, `plugin-mode`, `openclaw` subcommand) are inherited from the v0.11.x architecture. They get carved out into `packages/plugin` over the course of v0.12.0 commits, not all at once. **No new agent-aware code is added to proxy under any circumstances.**

## packages/plugin — `aquaman-plugin` on npm + ClawHub

**Role:** the OpenClaw adapter.

**Owns:** everything OpenClaw-aware — plugin manifest, plugin entry (`index.ts`), `openclaw.plugin.json`, OpenClaw env-writer, OpenClaw integration helpers, OpenClaw CLI command registration. After the v0.12.0 carve-out, also owns the OpenClaw setup logic (moved out of proxy CLI).

**Scope is frozen.** Code added here only for:
- OpenClaw compat fixes
- ClawScan / scanner remediation
- Manifest / config schema changes
- Bug fixes for OpenClaw-specific behavior

**Not in scope:** new coding-agent code, cross-agent CLI commands.

## packages/coder — `aquaman-coder` on npm (NEW v0.12.0)

**Role:** the coding-agent adapter — Claude Code, Codex, OpenCode, Cursor, and any future coding agent.

**Owns:**
- Per-agent hook handlers (`src/adapters/<agent>/hook.ts`)
- Per-agent setup writers (`src/adapters/<agent>/setup.ts`)
- Project credential map resolver (`~/.aquaman/projects.yaml`) — `src/projects/`
- Secret-pattern redactor — `src/redactor/`
- `aquaman-coder exec` helper — `src/exec.ts`
- `aquaman-coder` CLI: `setup <agent>`, `project <verb>`, `get <key>`, `exec <cmd>`, `hook --target <agent>`, `doctor`

**Does not know about:** OpenClaw.

**Depends on:** `aquaman-proxy` (exact pin) for vault access via the UDS broker endpoint.

## Cross-package imports

| Direction | Allowed? |
|---|---|
| `plugin` → `proxy` | ✓ Yes (plugin starts daemon, may import shared types) |
| `coder` → `proxy` | ✓ Yes (coder talks to broker endpoint, may import shared types) |
| `plugin` → `coder` | ✗ No |
| `coder` → `plugin` | ✗ No |
| `proxy` → `plugin` or `coder` | ✗ No (proxy is agent-agnostic) |

If you find yourself needing a forbidden import direction, the code probably belongs in a different package, or a shared type needs to be promoted into `proxy/src/core/` where both can consume it.

## When to add a new package

The default answer is **"no, organize inside an existing package."** Add a new package only when at least one of these holds:

- A subdirectory exceeds ~5,000 LOC **AND** has independent versioning needs (e.g., a single agent adapter is moving fast enough to warrant its own release cadence).
- An external registry (an agent's own plugin marketplace, like OpenClaw's ClawHub) requires a standalone published unit.
- A scanner finding can only be resolved by isolating a code path into its own published unit.

## What killed the old `packages/core`

The original v0.6.x monorepo had a `packages/core` scoped as "shared stuff between proxy and plugin." Without a clear named role, code drifted in without anyone asking "does this actually need to be cross-cutting?" The result was poor cohesion — eventually folded back into `packages/proxy` during the v0.7.0 cleanup.

**Lesson:** every package name should declare what the package is *for* in one word. `proxy` = the daemon. `plugin` = the OpenClaw adapter. `coder` = the coding-agent adapter. If a future package can't be summarized in one word, it doesn't have a clear role and shouldn't exist yet.
