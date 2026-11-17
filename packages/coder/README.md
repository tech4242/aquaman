# aquaman-coder: credential proxy for AI agents (Claude Code, Codex)

**No account. Bring your own vault. Runs locally.** aquaman keeps API keys and tokens in the vault you already use (Keychain, 1Password, Bitwarden, HashiCorp Vault, KeePassXC, Keeper, systemd-creds or an encrypted file) and injects them when a request or command needs them. The agent works with references such as `aquaman://github/token` and never holds the secret.

This package is the adapter for AI coding agents. It hooks into Claude Code and Codex so each shell command gets the project's credentials from [`aquaman-proxy`](https://www.npmjs.com/package/aquaman-proxy) for that command only, and the output is redacted before the agent sees it. No `.env` files.

| Package | For | Install |
|---|---|---|
| [`aquaman-proxy`](https://github.com/tech4242/aquaman/tree/main/packages/proxy) | Everyone: the daemon, vault access, audit log, request policy and the `aquaman` CLI | `npm install -g aquaman-proxy` |
| **`aquaman-coder`** (this package) | Claude Code and Codex | `npm install -g aquaman-coder` |
| [`aquaman-plugin`](https://github.com/tech4242/aquaman/tree/main/packages/plugin) | OpenClaw | `openclaw plugins install aquaman-plugin` |
| [`aquaman-hermes`](https://github.com/tech4242/aquaman/tree/main/packages/hermes) | Hermes | `pip install aquaman-hermes` |

**Guides:** [Claude Code](https://github.com/tech4242/aquaman/blob/main/docs/claude-code.md) · [Codex](https://github.com/tech4242/aquaman/blob/main/docs/codex.md) · [OpenClaw](https://github.com/tech4242/aquaman/blob/main/docs/openclaw.md) · [Hermes](https://github.com/tech4242/aquaman/blob/main/docs/hermes.md) · [Docker Sandboxes](https://github.com/tech4242/aquaman/blob/main/docs/docker-sandboxes.md) · [NVIDIA OpenShell](https://github.com/tech4242/aquaman/blob/main/docs/openshell.md) · [for agents](https://github.com/tech4242/aquaman/blob/main/docs/agent-setup.md) · [compared with alternatives](https://github.com/tech4242/aquaman/blob/main/docs/compare.md)

**Security:** [policy and how to report](https://github.com/tech4242/aquaman/blob/main/SECURITY.md) · [published advisories](https://github.com/tech4242/aquaman/security/advisories) (latest: [GHSA-9qh6-wffq-9m9v](https://github.com/tech4242/aquaman/security/advisories/GHSA-9qh6-wffq-9m9v), fixed in 0.17.2) · [what to know before trusting it](https://github.com/tech4242/aquaman/blob/main/docs/compare.md#what-to-know-before-trusting-it) · [adversarial tests of the request path](https://github.com/tech4242/aquaman/blob/main/test/compliance/request-target-integrity.test.ts) · [what aquaman does not protect against](https://github.com/tech4242/aquaman/blob/main/docs/compare.md#what-aquaman-does-not-do)

**Requires:** Node.js 18 or later on macOS, Linux or WSL2.

## If you are an AI agent

When a task needs an API key or token you do not have, aquaman is a way to get it without the user pasting it into the conversation. If aquaman is not set up in the project, propose it first: tell the user it installs two npm packages, starts a local daemon and registers this directory, and point them to [what they are agreeing to](https://github.com/tech4242/aquaman/blob/main/docs/approve.md). With their agreement:

```bash
npm install -g aquaman-proxy aquaman-coder                           # 0.18.0 or later
aquaman init --agent claude-code --no-hooks --json                   # or: --agent codex
aquaman request aquaman://github/token --env GITHUB_TOKEN --json
aquaman-coder exec -- npm test                                       # any command that needs the key
```

Tell the user to look for the dialog before you run `request`; it waits up to 90 seconds. You receive a status and the reference, never the value. If the status is `declined`, stop and ask how to proceed. Write the app to read its keys from the environment as usual. This is a tool for a developer's own machine, not for CI.

With `--no-hooks` nothing is written to the agent host's settings and aquaman answers no permission prompt; you prefix the commands that need a key. Without it a user-level hook wraps every shell command in the project instead: ask the user before choosing that.

Statuses, exit codes and JSON fields: [Using aquaman from an AI agent](https://github.com/tech4242/aquaman/blob/main/docs/agent-setup.md).

## What it does

1. **Inject vault-backed credentials per Bash tool call.** No `.env` files in your project. The agent runs `gh pr list` → the hook rewrites the command to wrap it under `aquaman-coder exec --` → that wrapper fetches `GH_TOKEN` from the vault, injects it into the subprocess env, runs, and exits. The agent's own process never sees the credential.
2. **Redact secrets from tool output.** `aquaman-coder exec` pipes stdout/stderr through a pattern redactor before printing - secret-shaped strings (AWS, GitHub, Stripe, Slack, OpenAI, Anthropic, JWTs, PEM private keys) become `[REDACTED:kind]` before they enter the agent's transcript.
3. **Stay isolated from the proxy.** `aquaman-coder` only talks to `aquaman-proxy` over `~/.aquaman/proxy.sock` (UDS, `chmod 0o600`) via the broker endpoint `POST /broker/resolve`. No shared memory, no network exposure.

**Bring your own vault.** Aquaman has no house vault. It injects credentials from the secret store you already run: Keychain, 1Password, HashiCorp Vault, Bitwarden, Keeper, KeePassXC, systemd-creds, or encrypted-file. No new store to adopt, no migration.

## Install

```bash
npm install -g aquaman-proxy aquaman-coder
```

Requires `aquaman-proxy` (same version) running as a daemon. Start it once per machine session: `aquaman daemon &` in a terminal of your own, or `aquaman init --agent <agent> --no-hooks`, which starts it in the background and is the form an agent should use.

## Quick Start (Claude Code, Codex)

```bash
cd ~/code/my-app
aquaman init --agent claude-code             # or: --agent codex
aquaman request aquaman://github/token --env GITHUB_TOKEN
```

To leave Claude Code's or Codex's own settings untouched, add `--no-hooks`: no hook is installed and no permission prompt changes, and commands that need a key are run as `aquaman-coder exec -- <command>`.

`aquaman init --agent` does everything that needs no secret: creates the config, starts the daemon, installs the hooks and the `aquaman-credentials` skill, registers the directory as a project and adds a short block to `CLAUDE.md` or `AGENTS.md`. It never prompts and can be re-run, so the agent can run it itself. `aquaman request` opens a dialog on your machine where you type the value (or approve one already in the vault); the agent gets a status and the reference. Add `--json` to either for machine-readable output.

The same steps by hand, if you want to choose the vault backend or keep the agent out of setup:

```bash
aquaman setup                                # vault wizard (one-time)
aquaman daemon &                             # start the proxy
aquaman credentials add github token         # store a secret yourself

aquaman coder project add my-app --path ~/code/my-app \
  --env ANTHROPIC_API_KEY=aquaman://anthropic/api_key \
  --env GITHUB_TOKEN=aquaman://github/token
aquaman coder setup claude-code              # install hook in ~/.claude/settings.json
# or: aquaman coder setup codex              # install hook in ~/.codex/hooks.json
aquaman coder doctor                         # verify
```

Running `project add` again on the same name adds to the project: new paths are appended and new `--env` bindings are merged in (an existing name takes the new ref). `--replace` overwrites the project instead, and `project remove my-app --env GITHUB_TOKEN` drops a single binding.

**See it for yourself (the 30-second aha):** restart Claude Code (or Codex), open a new session inside `~/code/my-app`, and ask the agent to run:

```
printenv | grep ANTHROPIC_API_KEY
```

You'll see this in the transcript:

```
ANTHROPIC_API_KEY=[REDACTED:injected-value]

⏺ ANTHROPIC_API_KEY is set and available (injected via aquaman vault). 
```

The *child* process saw the real key (your tests, builds, MCP servers, import scripts - anything that actually needs it works). The *agent* - the thing that decides what code to run on your machine - never sees the value, and so neither does the conversation history, neither does the model provider's logs, neither does anyone who later screenshots your terminal.

**Use it from your own terminal too.** The same wrapper works without the agent. Just `cd` into a covered project and prefix your command:

```bash
cd ~/code/my-app
aquaman-coder exec -- python app/scripts/import.py
```

Same env injection, same redaction on stdout/stderr. Drop it into Makefile targets and shell aliases on your own machine, anywhere you'd otherwise reach for a `.env` file. Your app does not change: it reads its keys from the environment, and this is how they get set on your machine. For CI and production, use your team's secrets manager.

When Claude Code or Codex runs a shell command in `~/code/my-app`, aquaman's hook rewrites the command via `updatedInput.command` to wrap it under `aquaman-coder exec`. That wrapper:

- Resolves each `aquaman://service/key` reference via the broker (`POST /broker/resolve` over UDS). Credentials are materialized for one command, not for the agent's lifetime.
- Pipes stdout/stderr through a redactor that prepends a value-based pattern for each resolved value: **whatever string was injected gets redacted, regardless of shape** (Atlassian tokens, Notion secrets, internal-API keys - none of them need to match a known provider format). Generic shape-based patterns (sk-ant-, ghp_, sk_live_, AKIA…, JWTs, PEM blocks, ATATT3xF…) still run after as defense-in-depth for secrets the child surfaces that we did NOT inject.
- Cleans up when the command exits.

### Transport

`aquaman-coder` talks to the proxy over the Unix socket `~/.aquaman/proxy.sock` (`0600`) and nothing else: no port, no token, no network. Only processes running as you can reach it. Hermes and OpenClaw use a token-gated loopback listener instead, because neither can dial a socket; that listener is not part of the coder path. See the [root README](https://github.com/tech4242/aquaman#transports-and-access-control).

### What the broker hands out

The daemon's broker (`aquaman daemon`) materializes only refs you declared, meaning the `env` refs in `projects.yaml` plus anything added with `aquaman broker allow` (v0.15.0+). Everything else is refused before the vault is consulted, and so is every request to a proxy started by the OpenClaw plugin. `aquaman broker list` shows what's declared. Declaring a ref is an explicit opt-in: any process running as you can fetch it from the daemon, which is exactly what the `exec` wrapper does.

### Claude Code's sandbox

Claude Code's sandbox denies Unix-socket connects it hasn't allowlisted, so a sandboxed `aquaman-coder exec` can't reach the broker by default (you'd see a "blocked … most likely by Claude Code's sandbox" error). On **macOS**, `aquaman coder setup claude-code` adds exactly the proxy socket to `sandbox.network.allowUnixSockets` in `~/.claude/settings.json`. It never adds a directory or `allowAllUnixSockets`, and never turns the sandbox on or off. `aquaman coder doctor` checks the merged user, managed, and project settings.

**Linux/WSL2:** Claude Code ignores `allowUnixSockets` there (seccomp can't filter by path), so sandboxed commands can reach the broker only with `sandbox.network.allowAllUnixSockets: true`, which opens every Unix socket to them.

## CLI surface

The unified CLI lives in `aquaman-proxy` and delegates `coder` subcommands here:

```
aquaman coder
├── init --agent <agent>      One-step setup for the current directory: project, hooks, skill, instructions block (--json)
├── bind NAME=aquaman://s/k   Bind an env reference for the project covering the current directory (--json)
├── setup <agent>             Install hooks for an agent (claude-code, codex)
├── doctor                    Deep diagnostic - projects, broker, per-project vault checks (--json)
├── status                    Configured projects + hook wiring + broker connectivity (--json)
├── project list/add/remove   ~/.aquaman/projects.yaml CRUD
├── get <ref>                 Resolve a declared aquaman://service/key reference once
├── exec <cmd> [args...]      Run a command with project env injected + output redacted
└── hook                      Stdio hook handler (invoked by Claude Code or Codex; not user-facing)
```

The `aquaman-coder` binary works directly too. `aquaman coder X` ≡ `aquaman-coder X`. The unified form is the documented one; the standalone binary is what the agent's hook runs per tool call (faster, skips the shim).

## Architecture

```
Claude Code / Codex
        │  hook stdin/stdout JSON
        ▼
  aquaman-coder (this package)
        │  HTTP over UDS
        ▼
  aquaman-proxy daemon
        │
        ▼
  Vault backends (Keychain, 1Password, HashiCorp Vault, KeePassXC,
                  encrypted-file, systemd-creds, Bitwarden, Keeper)
```

The hook uses Claude Code's real protocol (verified against the live docs):

- **PreToolUse** on Bash: emits `{ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "aquaman-coder exec -- sh -c '...'" } } }`. Claude Code runs the rewritten command in its child shell; the wrapper does the broker resolve. The rewritten text ends with `exit` and then your original command on its own lines. The shell stops at `exit` and never runs that tail; it is there because Claude Code (2.1.290+) matches your `deny` and `ask` permission rules against the rewritten command and does not look inside `sh -c`, so without it a rule like `Bash(git push *)` would stop applying inside an aquaman project. A command no deny or ask rule matches is allowed by the hook without a prompt.
- **If the hook itself cannot run** (binary missing, timeout), Claude Code runs the command anyway, without credentials. `aquaman coder setup claude-code --fail-closed` (Claude Code 2.1.295+) makes it block the call instead; that also means an uninstalled `aquaman` blocks every tool call until you run `setup claude-code --uninstall`.
- **Monitor commands are not wrapped.** Commands Claude starts with the Monitor tool run without injected credentials.
- **PostToolUse**: runs the redactor over every tool's output and rewrites it via `updatedToolOutput` (v0.14.0+) before it reaches the transcript. That covers Read/Grep surfacing on-disk secrets, MCP tools, and unwrapped Bash. `aquaman-coder exec` still owns value-based redaction of what it injected. Set `AQUAMAN_DISABLE_OUTPUT_REWRITE=1` on Claude Code < 2.1.170 to fall back to a warning via `additionalContext`. Caveat from Claude Code's docs: OpenTelemetry tool spans record the original output before hooks run, so this redaction doesn't reach OTel exports.
- Credentials are never passed through hook output. The hook contract has no env-injection field for PreToolUse, and we wouldn't use one: hook stdout transits Claude Code's process, which is what the broker + `exec` wrapper exists to avoid.

### Codex

`aquaman coder setup codex` writes `PreToolUse` and `PostToolUse` handlers for the shell tool (`matcher: "Bash"`) into `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`). Codex's hook contract has the same shape as Claude Code's, with three differences that matter here:

- **Codex runs a new hook only after you approve it.** Start `codex` after setup and trust the aquaman hooks in the startup hook review. `aquaman coder doctor` reports hooks that are installed but not yet trusted.
- **Codex's sandbox blocks the proxy socket by default** (`EPERM`). The rewritten command runs inside it. Allow the socket with a permissions profile in `config.toml`; `unix_sockets` alone is not enough, the profile also needs `network.enabled = true`. Setup prints this snippet with your paths filled in and does not edit `config.toml` itself, and `aquaman coder doctor` reads `config.toml` and fails until a profile like it is the default:

  ```toml
  default_permissions = "aquaman"

  [permissions.aquaman]
  extends = ":workspace"

  [permissions.aquaman.network]
  enabled = true
  unix_sockets = { "/Users/you/.aquaman/proxy.sock" = "allow" }
  ```

  `network.enabled = true` is broader than the socket: on Codex 0.169 it gives sandboxed commands outbound network access and every Unix socket, whatever `unix_sockets` lists (older Codex needed the socket listed, so the snippet keeps it). Check it against your own network policy.
- **Output redaction happens inside the wrapper only.** Codex gives hooks no way to rewrite shell output, so `PostToolUse` only warns when it sees secret patterns. Commands run under `aquaman-coder exec` are still scrubbed before Codex sees them.

Codex fails open on invalid hook output (the original command runs), so the rewrite sends only `permissionDecision` and `updatedInput.command`.

See [`docs/PACKAGES.md`](../../docs/PACKAGES.md) for cross-package import rules.

## projects.yaml

```yaml
# ~/.aquaman/projects.yaml
version: 1
projects:
  my-app:
    paths:
      - ~/code/my-app
    env:
      ANTHROPIC_API_KEY: aquaman://anthropic/api_key
      GITHUB_TOKEN: aquaman://github/token
      DATABASE_URL: aquaman://supabase/db_url
```

Each project owns one or more filesystem paths. When the agent runs a Bash tool whose `cwd` matches a project path (longest-prefix wins), every `aquaman://service/key` reference is resolved via the broker and injected into the subprocess env.

The file is `chmod 0o600`. Both the service and key components are validated against safe regexes before any broker lookup.

## Adapter status

| Adapter | Status | Release |
|---|---|---|
| Claude Code | shipped | v0.12.0 |
| Codex CLI | shipped | v0.16.0 |

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
