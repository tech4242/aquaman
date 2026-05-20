# aquaman-coder

**Vault adapter for AI coding agents.** Keep API keys, secrets, and `.env` contents out of your coding agent's memory and transcripts.

Pair with [`aquaman-proxy`](../proxy) (the vault + daemon + audit core). Together: `aquaman-proxy` holds credentials in a separate process; `aquaman-coder` hooks into your coding agent so per-tool-call commands get credentials materialized over UDS, run with output redacted, and the agent never sees raw keys.

## What it does

1. **Inject vault-backed credentials per Bash tool call.** No `.env` files in your project. The agent runs `gh pr list` → the hook rewrites the command to wrap it under `aquaman-coder exec --` → that wrapper fetches `GH_TOKEN` from the vault, injects it into the subprocess env, runs, and exits. The agent's own process never sees the credential.
2. **Redact secrets from tool output.** `aquaman-coder exec` pipes stdout/stderr through a pattern redactor before printing — secret-shaped strings (AWS, GitHub, Stripe, Slack, OpenAI, Anthropic, JWTs, PEM private keys) become `[REDACTED:kind]` before they enter the agent's transcript.
3. **Stay isolated from the proxy.** `aquaman-coder` only talks to `aquaman-proxy` over `~/.aquaman/proxy.sock` (UDS, `chmod 0o600`) via the broker endpoint `POST /broker/resolve`. No shared memory, no network exposure.

## Install

```bash
npm install -g aquaman-proxy aquaman-coder
```

Requires `aquaman-proxy` (same version) running as a daemon — start it once per machine session with `aquaman daemon &` (or have it managed by your shell's init).

## Quick Start (Claude Code)

```bash
aquaman setup                                # vault wizard (one-time)
aquaman daemon &                             # start the proxy

aquaman coder project add my-app --path ~/code/my-app \
  --env ANTHROPIC_API_KEY=aquaman://anthropic/api_key \
  --env GITHUB_TOKEN=aquaman://github/token
aquaman coder setup claude-code              # install hook in ~/.claude/settings.json
aquaman coder doctor                         # verify
```

**See it for yourself (the 30-second aha):** restart Claude Code, open a new session inside `~/code/my-app`, and ask the agent to run:

```
printenv | grep ANTHROPIC_API_KEY
```

You'll see this in the transcript:

```
ANTHROPIC_API_KEY=[REDACTED:injected-value]

⏺ ANTHROPIC_API_KEY is set and available (injected via aquaman vault). 
```

The *child* process saw the real key (your tests, builds, MCP servers, import scripts — anything that actually needs it works). The *agent* — the thing that decides what code to run on your machine — never sees the value, and so neither does the conversation history, neither does the model provider's logs, neither does anyone who later screenshots your terminal.

**Use it from your own terminal too.** The same wrapper works without the agent — just `cd` into a covered project and prefix your command:

```bash
cd ~/code/
aquaman-coder exec -- python app/scripts/import.py
```

Same env injection, same redaction on stdout/stderr. Drop it into Makefile targets, shell aliases, or CI runners — anywhere you'd otherwise reach for a `.env` file.

When Claude Code runs a Bash tool in `~/code/my-app`, aquaman's hook rewrites the command via `updatedInput.command` to wrap it under `aquaman-coder exec`. That wrapper:

- Resolves each `aquaman://service/key` reference via the broker (`POST /broker/resolve` over UDS) — credentials are materialized for one command, not for the agent's lifetime.
- Pipes stdout/stderr through a redactor that prepends a value-based pattern for each resolved value: **whatever string was injected gets redacted, regardless of shape** (Atlassian tokens, Notion secrets, internal-API keys — none of them need to match a known provider format). Generic shape-based patterns (sk-ant-, ghp_, sk_live_, AKIA…, JWTs, PEM blocks, ATATT3xF…) still run after as defense-in-depth for secrets the child surfaces that we did NOT inject.
- Cleans up when the command exits.

## CLI surface

The unified CLI lives in `aquaman-proxy` and delegates `coder` subcommands here:

```
aquaman coder
├── setup <agent>             Install hooks for an agent (claude-code today)
├── doctor                    Deep diagnostic — projects, broker, per-project vault checks
├── status                    Configured projects + hook wiring + broker connectivity
├── project list/add/remove   ~/.aquaman/projects.yaml CRUD
├── get <ref>                 Resolve an aquaman://service/key reference once
├── exec <cmd> [args...]      Run a command with project env injected + output redacted
└── hook                      Stdio hook handler (invoked by Claude Code; not user-facing)
```

The `aquaman-coder` binary works directly too — `aquaman coder X` ≡ `aquaman-coder X`. The unified form is the documented one; the standalone binary is what Claude Code's hook contract executes per tool call (faster, skips the shim).

## Architecture

```
Claude Code / Codex / OpenCode / Cursor
        │  hook stdin/stdout JSON
        ▼
  aquaman-coder (this package)
        │  HTTP over UDS
        ▼
  aquaman-proxy daemon
        │
        ▼
  Vault backends (Keychain, 1Password, HashiCorp Vault, KeePassXC,
                  encrypted-file, systemd-creds, Bitwarden)
```

The hook uses Claude Code's real protocol (verified against the live docs):

- **PreToolUse** on Bash: emits `{ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "aquaman-coder exec -- sh -c '...'" } } }`. Claude Code runs the rewritten command in its child shell; the wrapper does the broker resolve.
- **PostToolUse**: emits `{ hookSpecificOutput: { additionalContext: "aquaman: tool output contained secret patterns…" } }` if the redactor finds secrets in the output. Note: PostToolUse can't *rewrite* output (the tool already ran) — real scrubbing happens inside `aquaman-coder exec`'s stdout pipeline. PostToolUse is purely an alert.

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
| Codex CLI | planned | v0.13.0 |
| OpenCode (sst) | planned | v0.14.0 |
| Cursor | planned | v0.15.0 |

## License

MIT — see [LICENSE](./LICENSE).
