# aquaman-hermes: credential proxy for AI agents (Hermes)

**No account. Bring your own vault. Runs locally.** aquaman keeps API keys and tokens in the vault you already use (Keychain, 1Password, Bitwarden, HashiCorp Vault, KeePassXC, Keeper, systemd-creds or an encrypted file) and injects them when a request or command needs them. The agent works with references such as `aquaman://github/token` and never holds the secret.

This package is the plugin for the [Hermes](https://github.com/NousResearch/hermes-agent) agent host. The isolation itself is done by [`aquaman-proxy`](https://www.npmjs.com/package/aquaman-proxy), which Hermes is pointed at through its own `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` settings; this plugin adds a `/aquaman-status` command, an `aquaman_status` tool, a session-start health check and a secret source for project secrets. It holds no credentials.

| Package | For | Install |
|---|---|---|
| [`aquaman-proxy`](https://github.com/tech4242/aquaman/tree/main/packages/proxy) | Everyone: the daemon, vault access, audit log, request policy and the `aquaman` CLI | `npm install -g aquaman-proxy` |
| [`aquaman-coder`](https://github.com/tech4242/aquaman/tree/main/packages/coder) | Claude Code and Codex | `npm install -g aquaman-coder` |
| [`aquaman-plugin`](https://github.com/tech4242/aquaman/tree/main/packages/plugin) | OpenClaw | `openclaw plugins install aquaman-plugin` |
| **`aquaman-hermes`** (this package) | Hermes | `pip install aquaman-hermes` |

**Guides:** [Claude Code](https://github.com/tech4242/aquaman/blob/main/docs/claude-code.md) · [Codex](https://github.com/tech4242/aquaman/blob/main/docs/codex.md) · [OpenClaw](https://github.com/tech4242/aquaman/blob/main/docs/openclaw.md) · [Hermes](https://github.com/tech4242/aquaman/blob/main/docs/hermes.md) · [Docker Sandboxes](https://github.com/tech4242/aquaman/blob/main/docs/docker-sandboxes.md) · [NVIDIA OpenShell](https://github.com/tech4242/aquaman/blob/main/docs/openshell.md) · [for agents](https://github.com/tech4242/aquaman/blob/main/docs/agent-setup.md) · [compared with alternatives](https://github.com/tech4242/aquaman/blob/main/docs/compare.md)

**Security:** [policy and how to report](https://github.com/tech4242/aquaman/blob/main/SECURITY.md) · [published advisories](https://github.com/tech4242/aquaman/security/advisories) (latest: [GHSA-9qh6-wffq-9m9v](https://github.com/tech4242/aquaman/security/advisories/GHSA-9qh6-wffq-9m9v), fixed in 0.17.2) · [what to know before trusting it](https://github.com/tech4242/aquaman/blob/main/docs/compare.md#what-to-know-before-trusting-it) · [adversarial tests of the request path](https://github.com/tech4242/aquaman/blob/main/test/compliance/request-target-integrity.test.ts) · [what aquaman does not protect against](https://github.com/tech4242/aquaman/blob/main/docs/compare.md#what-aquaman-does-not-do)

**Requires:** Python 3.10 or later for this plugin; the proxy it talks to needs Node.js 18 or later on macOS, Linux or WSL2.

## If you are an AI agent

When a task needs an API key or token, do not ask the user to paste it. Set the project up once, then ask for the credential by reference. A person supplies the value in a dialog; you get a status and the reference, never the value.

```bash
aquaman init --agent claude-code --no-hooks --json                   # or: --agent codex
aquaman request aquaman://github/token --env GITHUB_TOKEN --json
aquaman-coder exec -- npm test                                       # any command that needs the key
```

With `--no-hooks` nothing is written to the agent host's settings and no permission prompt changes; you prefix the commands that need a key. Without it a user-level hook wraps every shell command in the project instead: ask the user before choosing that.

Statuses, exit codes and JSON fields: [Using aquaman from an AI agent](https://github.com/tech4242/aquaman/blob/main/docs/agent-setup.md). These two commands are for coding agents; Hermes is wired by `aquaman hermes setup` below.

## What this plugin adds

- **`/aquaman-status`**: a slash command showing whether the proxy is reachable and how Hermes is wired.
- **`aquaman_status`**: a tool with the same information for the agent.
- **`on_session_start`**: a one-shot health check that warns if the proxy is down.
- **`aquaman` secret source** (Hermes 0.18.1 and later): resolves project and tool secrets (GitHub tokens, database URLs, anything under `secrets.aquaman.env`) from your vault at startup, through the proxy's token-gated broker. See below.

## How it works

```
Hermes process                         aquaman-proxy (separate process)
┌────────────────────────┐             ┌────────────────────────────────┐
│ ANTHROPIC_BASE_URL =   │── HTTP ────▶│ 127.0.0.1:8585 loopback        │
│  http://127.0.0.1:8585 │  (loopback, │  • validates loopback token    │
│  /anthropic            │   token-    │  • injects real key from vault │
│ ANTHROPIC_API_KEY =    │   gated)    │  • forwards to api.anthropic   │
│  <loopback token>      │◀────────────│  • writes hash-chained audit   │
│ NO real credentials    │             └────────────────────────────────┘
└────────────────────────┘
```

## Install

You need the proxy (`aquaman-proxy`, from npm) and this plugin (from PyPI):

```bash
# 1. Proxy + vault (Node)
npm install -g aquaman-proxy
aquaman setup                                   # pick a backend, store keys
aquaman credentials add anthropic api_key          # prompts for the value, input hidden

# 2. This plugin (Python)
pip install aquaman-hermes        # or: uv tool install aquaman-hermes
aquaman-hermes install            # drops the plugin into ~/.hermes/plugins/aquaman/
hermes plugins enable aquaman     # add to plugins.enabled

# 3. Wire Hermes at the proxy + start it
aquaman hermes setup              # writes ~/.hermes/.env, enables the loopback listener
aquaman daemon &                  # start the proxy

# 4. Verify
aquaman hermes doctor             # deep diagnostic (proxy side)
hermes                            # then run: /aquaman-status
```

`aquaman-hermes install` honors `HERMES_HOME` (the same var the Hermes CLI uses to
relocate its config dir); it defaults to `~/.hermes`.

## Transport and access control

Hermes reaches the proxy over the token-gated loopback listener `127.0.0.1:<port>`, because Hermes builds its own HTTP client and cannot dial a Unix socket. Since aquaman v0.15.0 OpenClaw's model traffic uses the same listener, for the same reason; coding agents still use the socket `~/.aquaman/proxy.sock` (`0600`).

The token is a capability to reach the local proxy, not a credential: generated per install, stored in `~/.aquaman/config.yaml` (`0600`) and in the managed block of `~/.hermes/.env`, and stripped by the proxy before your real key is injected. Any local process can reach a loopback port, including other users, where the socket's `0600` shuts them out. The token is the gate there, and the listener stays off until you run `aquaman hermes setup`.

## Project secrets (secret source, Hermes ≥ 0.18.1)

LLM keys are only half the problem. Agents also need GitHub tokens, database URLs,
and other project secrets that usually end up in a plaintext `.env`. On Hermes ≥
0.18.1 this plugin registers an `aquaman` secret source so those come from your
vault instead. Bind them in `~/.hermes/config.yaml`:

```yaml
secrets:
  aquaman:
    enabled: true
    env:
      GITHUB_TOKEN: aquaman://github/token
      DATABASE_URL: aquaman://supabase/db_url
```

Then declare the same refs to the proxy. Since aquaman 0.15 the daemon hands out
only refs you have declared, so a binding in Hermes' config alone is refused:

```bash
aquaman broker allow aquaman://github/token aquaman://supabase/db_url
aquaman hermes doctor   # flags any binding that isn't declared yet
```

At startup the source resolves each binding through the proxy's token-gated
loopback broker (per-read, hash-chain audited) and hands the values to Hermes'
secret orchestrator. Notes on the security model:

- **LLM provider keys are refused**, by this source and by the proxy itself.
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` bindings are rejected with a warning, and the
  proxy never hands out anthropic/openai keys over the loopback listener even if they
  are declared. Those stay on the loopback proxy path, where the real key never enters
  the Hermes process at all.
- Project secrets resolved this way **do** live in Hermes' process env (that's what a
  Hermes secret source is). What you gain over a `.env` line: vault-at-rest storage,
  per-read tamper-evident audit, instant rotation, and no plaintext files on disk.
- Fail-open by design: if the proxy is down, Hermes still starts (with a warning).
- One bad ref never blocks the others; errors/warnings never contain the token.

On Hermes 0.19+ the source participates in the full orchestrator: mapped-vs-bulk
precedence (an explicit `env:` binding outranks a bulk project dump), first-claim-wins
across sources with conflict warnings, and `(from Aquaman Proxy)` provenance labels.
Order it against other sources with `secrets.sources: [aquaman, bitwarden]`. The source
passes Hermes' own secret-source conformance kit (see `tests/test_conformance.py`).

**Timing caveat:** plugin discovery runs later in Hermes' startup than the first
`load_hermes_dotenv()` call, so a plugin-provided source is not consulted by the very
first env load of the process that discovers it. It *is* consulted by every subsequently
spawned Hermes process (gateway children, cron sessions, subagents). Bundled sources
cover first-process bootstrap; that's a Hermes design property, not an aquaman gap.

## Uninstall

```bash
hermes plugins disable aquaman
aquaman-hermes uninstall
```

## Notes

- The status/command/hook surface holds no credentials. It only reads the provider
  base-URL env vars and probes the proxy's token-exempt `/_health` endpoint. The
  secret source transits credentials only while handing them to Hermes' orchestrator.
- It depends only on the Python standard library.
- LLM providers wired via base-URL: Anthropic + OpenAI. Channels are out of scope for
  the Hermes path (no base-URL lever); project secrets go through the secret source.
- Hermes >=0.17 "managed scope": a root-owned `/etc/hermes/.env` overrides
  `~/.hermes/.env`. If an admin pins the `ANTHROPIC_*`/`OPENAI_*` vars there, the
  proxy is bypassed. `aquaman hermes doctor` detects and flags this.
- With `gateway.multiplex_profiles` enabled (off by default), env is scoped per
  profile: add the aquaman block to each profile's env file.
- Hermes 0.18's cron exfil guard refuses cron jobs that pair a named provider with
  an off-host `base_url` override; normal jobs inheriting the session runtime (the
  env vars aquaman writes) are unaffected.
