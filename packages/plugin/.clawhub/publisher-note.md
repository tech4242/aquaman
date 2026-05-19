The aquaman-proxy binary is bundled as an exact-pinned npm dependency, published by the same author (tech4242), and the plugin warns at startup if the running proxy version disagrees with its own.

The HttpInterceptor strips Authorization and X-API-Key headers from outgoing agent requests before routing them to the local proxy, so credentials never enter the agent process even if upstream SDKs preset them.

The HTTP interceptor only redirects traffic for services explicitly listed in the plugin's services config (v0.11.4+); channels not in services keep their normal direct-to-upstream behavior. The built-in host map is a catalog of supported services, not a list of what gets intercepted on any given install.

Auto-generated auth-profiles.json placeholders cover only anthropic and openai, never overwrite an existing file, and can be disabled via autoGenerateAuthProfiles: false in the plugin config (v0.11.4+).

When using the Vault backend, the user-provided Vault token is forwarded to the proxy process via the AQUAMAN_VAULT_TOKEN environment variable. Use least-privilege tokens with narrow policy and short TTLs. v0.11.5+ narrows the spawned proxy's inherited environment to an explicit allowlist (process basics, locale, AQUAMAN_*/VAULT_*/BW_* prefixes) rather than forwarding the full parent env.

Spawning aquaman-proxy as a separate process is the plugin's purpose: credentials live in the proxy address space, not in the agent process. The plugin is a no-op without it.

The audit log at ~/.aquaman/audit/current.jsonl records request metadata (service, method, path, outcome) and a SHA-256 hash chain — not credential values. v0.11.5+ auto-rotates the log at 10 MB and retains the last 10 archives in ~/.aquaman/audit/archive/. The log stays local with no telemetry. The policy config in ~/.aquaman/config.yaml can deny specific upstream endpoints before credential injection; denied requests return 403.

Source: https://github.com/tech4242/aquaman
