Aquaman is a credential isolation plugin: API keys and channel tokens live in a separate proxy process (the `aquaman` binary from the `aquaman-proxy` npm package) and are injected into outbound requests on the fly. The agent process never sees the secret. This shape is intentional and produces several of the behavioral signals ClawScan flags. Context for each finding:

**ASI04 (supply chain — bundled proxy binary).** `aquaman-proxy` is declared as an exact-version dependency in this plugin's `package.json` (no semver range — npm installs exactly the version this plugin shipped against) and is published by the same author (`tech4242`) on the public npm registry. The plugin checks the running proxy's reported version against its own at startup and logs a warning if they disagree. Source: https://github.com/tech4242/aquaman.

**ASI02 (host map breadth).** v0.11.4+ filters the HTTP interceptor host map by the user's `services` config — only services the operator explicitly opted into in `openclaw.json` get their traffic redirected. The 26-entry fallback map is a *catalog* of known services, not a list of what gets intercepted on any given install.

**ASI03 (auto-generated auth profiles).** The plugin only generates placeholder profiles for `anthropic` and `openai` (never arbitrary services) and only when `auth-profiles.json` doesn't already exist — it never overwrites an existing file. v0.11.4+ exposes `autoGenerateAuthProfiles: false` in the plugin config for operators who manage their own auth profiles.

**ASI05 (dangerous-exec — spawning the proxy).** Intentional and disclosed. The plugin's entire purpose is to run the proxy as an out-of-process credential isolator. The spawn target is the `aquaman` binary from the bundled `aquaman-proxy` dependency. Without it, the plugin is a no-op.

**ASI07 (audit log + traffic routing).** The audit log is written to `~/.aquaman/audit/current.jsonl` with a SHA-256 hash chain — local-only, no telemetry. `aquaman doctor` surfaces issues; `aquaman audit tail` shows recent entries. Operators can constrain which upstream endpoints get proxied (and therefore credentialed) via the `policy` config in `~/.aquaman/config.yaml`; denied requests return 403 before any credential is injected.

See `packages/plugin/README.md` "Security model" section for the full design rationale.
