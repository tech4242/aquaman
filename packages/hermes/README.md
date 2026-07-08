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

## Uninstall

```bash
hermes plugins disable aquaman
aquaman-hermes uninstall
```

## Notes

- The plugin holds no credentials and makes no privileged calls. It only reads the
  provider base-URL env vars and probes the proxy's token-exempt `/_health` endpoint.
- It depends only on the Python standard library.
- Only LLM providers (Anthropic, OpenAI) are wired today. Channels/other providers are
  out of scope for the Hermes path (no base-URL lever to redirect them).
- Hermes >=0.17 "managed scope": a root-owned `/etc/hermes/.env` overrides
  `~/.hermes/.env` — if an admin pins the `ANTHROPIC_*`/`OPENAI_*` vars there, the
  proxy is bypassed. `aquaman hermes doctor` detects and flags this.
- With `gateway.multiplex_profiles` enabled (off by default), env is scoped per
  profile — add the aquaman block to each profile's env file.
- Hermes 0.18's cron exfil guard refuses cron jobs that pair a named provider with
  an off-host `base_url` override; normal jobs inheriting the session runtime (the
  env vars aquaman writes) are unaffected.
