The aquaman-proxy binary is bundled as an exact-pinned npm dependency, published by the same author (tech4242), and the plugin warns at startup if the running proxy version disagrees with its own.

The HTTP interceptor only redirects traffic for services explicitly listed in the plugin's services config (v0.11.4+); channels not in services keep their normal direct-to-upstream behavior. The built-in host map is a catalog of supported services, not a list of what gets intercepted on any given install.

Auto-generated auth-profiles.json placeholders cover only anthropic and openai, never overwrite an existing file, and can be disabled via autoGenerateAuthProfiles: false in the plugin config (v0.11.4+).

Spawning aquaman-proxy as a separate process is the plugin's purpose: credentials live in the proxy address space, not in the agent process. The plugin is a no-op without it.

The audit log at ~/.aquaman/audit/current.jsonl is hash-chained and stays local with no telemetry. The policy config in ~/.aquaman/config.yaml can deny specific upstream endpoints before credential injection; denied requests return 403.

Source: https://github.com/tech4242/aquaman
