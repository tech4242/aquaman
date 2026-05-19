# aquaman-coder

**Vault adapter for AI coding agents.** Keep API keys, secrets, and `.env` contents out of your coding agent's memory and transcripts.

> ⚠️ **v0.12.0-pre — under construction.** Package skeleton added in the v0.12.0 carve-out. The Claude Code adapter, `aquaman-coder` CLI, projects.yaml, redactor, and compliance scaffolding land in subsequent v0.12.0 commits. **Not yet published to npm.**

## What this will be

A companion package to [`aquaman-proxy`](../proxy) that hooks into AI coding agents (Claude Code first; Codex / OpenCode / Cursor coming) to:

1. **Inject vault-backed credentials per shell call.** No `.env` files in your project. The agent runs `gh pr list` → aquaman-coder hook fetches `GH_TOKEN` from your vault → injects for that one command → scrubs after. Disk forensics finds nothing.
2. **Block secret reads at the hook.** Agent tries to read `.env*`, `*.pem`, `id_rsa`, `.aws/credentials`, `.ssh/*` → blocked before the tool fires.
3. **Redact secrets from tool output.** Pattern-match outputs against known secret shapes (AWS, GitHub, Stripe, Slack, OpenAI, Anthropic, JWTs, private keys) → replace with `[redacted]` before the transcript captures them.
4. **Isolate LLM provider keys.** Use Claude Code's `apiKeyHelper` / Codex's `[model_providers].auth.command` to route LLM calls through the proxy without the agent ever seeing the real key.

## Architecture

`aquaman-coder` is a CLI + hook adapter that talks to `aquaman-proxy` over a Unix Domain Socket (`~/.aquaman/proxy.sock`). The proxy daemon holds vault access; coder shapes broker responses into each agent's hook contract.

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

See [`docs/PACKAGES.md`](../../docs/PACKAGES.md) for package boundary rules and what belongs in each of the three packages (`proxy` / `plugin` / `coder`).

## Status

| Adapter | Status | Release |
|---|---|---|
| Claude Code | in progress | v0.12.0 |
| Codex CLI | planned | v0.13.0 |
| OpenCode (sst) | planned | v0.14.0 |
| Cursor | planned | v0.15.0 |

## License

MIT — see [LICENSE](./LICENSE).
