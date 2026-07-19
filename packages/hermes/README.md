# aquaman-hermes

Credential isolation for the [Hermes](https://github.com/NousResearch/hermes-agent)
agent host - using the vault you already have. API keys live in your existing
backend (Keychain, 1Password, HashiCorp Vault, Bitwarden, KeePassXC, systemd-creds,
or encrypted-file) and are injected by the **aquaman proxy**. They never enter the
Hermes process, and you never copy them into a new store.

This is the optional, in-session "sugar" layer. The actual isolation is done by
`aquaman-proxy`: it runs an opt-in loopback listener and Hermes is pointed at it via
its native `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` env vars (written to
`~/.hermes/.env`) plus a placeholder api_key that the proxy strips and replaces with
the real credential. This plugin adds:

- **`/aquaman-status`**: slash command showing proxy reachability + wiring.
- **`aquaman_status`**: an agent-facing tool with the same info.
- **`on_session_start`**: a one-shot health probe that warns if the proxy is down.
- **`aquaman` secret source** (Hermes ≥ 0.18.1): resolves project/tool secrets —
  GitHub tokens, database URLs, anything under `secrets.aquaman.env` — from your
  vault at startup, through the proxy's token-gated broker. See below.

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
aquaman credentials add anthropic api_key sk-ant-...

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

## Project secrets (secret source, Hermes ≥ 0.18.1)

LLM keys are only half the problem — agents also need GitHub tokens, database URLs,
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

At startup the source resolves each binding through the proxy's token-gated
loopback broker (per-read, hash-chain audited) and hands the values to Hermes'
secret orchestrator. Notes on the security model:

- **LLM provider keys are refused.** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` bindings
  are rejected with a warning — those stay on the loopback proxy path, where the real
  key never enters the Hermes process at all.
- Project secrets resolved this way **do** live in Hermes' process env (that's what a
  Hermes secret source is). What you gain over a `.env` line: vault-at-rest storage,
  per-read tamper-evident audit, instant rotation, and no plaintext files on disk.
- Fail-open by design: if the proxy is down, Hermes still starts (with a warning).
- One bad ref never blocks the others; errors/warnings never contain the token.

## Uninstall

```bash
hermes plugins disable aquaman
aquaman-hermes uninstall
```

## Notes

- The status/command/hook surface holds no credentials — it only reads the provider
  base-URL env vars and probes the proxy's token-exempt `/_health` endpoint. The
  secret source transits credentials only while handing them to Hermes' orchestrator.
- It depends only on the Python standard library.
- LLM providers wired via base-URL: Anthropic + OpenAI. Channels are out of scope for
  the Hermes path (no base-URL lever); project secrets go through the secret source.
- Hermes >=0.17 "managed scope": a root-owned `/etc/hermes/.env` overrides
  `~/.hermes/.env` — if an admin pins the `ANTHROPIC_*`/`OPENAI_*` vars there, the
  proxy is bypassed. `aquaman hermes doctor` detects and flags this.
- With `gateway.multiplex_profiles` enabled (off by default), env is scoped per
  profile — add the aquaman block to each profile's env file.
- Hermes 0.18's cron exfil guard refuses cron jobs that pair a named provider with
  an off-host `base_url` override; normal jobs inheriting the session runtime (the
  env vars aquaman writes) are unaffected.
