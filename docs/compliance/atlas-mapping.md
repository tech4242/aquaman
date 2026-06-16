# MITRE ATLAS Mapping

Aquaman maps to **MITRE ATLAS v5.4.0 (Adversarial Threat Landscape for Artificial-Intelligence Systems)** — a stable, machine-readable catalog of adversary techniques widely cited in audit reports. The 2026 ATLAS updates added agent-focused techniques; the one most directly in aquaman's lane is **AML.T0098 (AI Agent Tool Credential Harvesting)**, mapped below.

Below: each ATLAS technique aquaman addresses, the aquaman feature that mitigates it, and the runnable test that proves the mitigation holds.

Run all ATLAS conformance tests with `vitest run test/compliance/atlas/` (or just `npm test`, which runs the whole suite).

| Technique | Title | Aquaman mitigation | Test |
|---|---|---|---|
| **AML.T0055** | Unsecured Credentials | Credentials live in a vault backend (Keychain, 1Password, HashiCorp Vault, KeePassXC, encrypted-file, systemd-creds, Bitwarden). The agent process never sees them — only a sentinel base-URL and a placeholder `aquaman-proxy-managed` marker. The proxy strips placeholder + injects the real credential before forwarding upstream. Post-tool-output redactor catches secrets that might leak into transcripts. | [`test/compliance/atlas/t0055-unsecured-credentials.test.ts`](../../test/compliance/atlas/t0055-unsecured-credentials.test.ts) |
| **AML.T0012** | Valid Accounts | Even with valid credentials injected, request-level policy enforcement (method + path deny rules per service) blocks privileged paths *before* credentials are injected. Hash-chained audit log records every denied request with tamper-evident chain. Denied requests never reach the upstream provider. | [`test/compliance/atlas/t0012-valid-accounts.test.ts`](../../test/compliance/atlas/t0012-valid-accounts.test.ts) |
| **AML.T0062** | Exfiltration via AI Agent Tool Invocation | Same policy engine + audit log. An agent that tries to exfiltrate via a sanctioned tool call (e.g., `Authorization`-bearing `curl`) is intercepted by the proxy, evaluated against policy, and either denied (403) or logged. Header-stripping in the HTTP interceptor removes `Authorization` + `X-API-Key` from outgoing requests before routing — so even if the agent presets them, they're scrubbed before egress. | [`test/compliance/atlas/t0062-exfiltration-via-tool.test.ts`](../../test/compliance/atlas/t0062-exfiltration-via-tool.test.ts) |
| **AML.T0090** | OS Credential Dumping (Process credential access) | Credentials never reside in the agent's process address space. They live in a separate proxy process accessed via Unix Domain Socket (`chmod 0o600`). Even RCE in the agent cannot dump credentials from the agent's own memory because they were never there. The broker endpoint (v0.12.0+) materializes credentials per tool call and the consumer scrubs them after the indicated TTL. | [`test/compliance/atlas/t0090-os-credential-dumping.test.ts`](../../test/compliance/atlas/t0090-os-credential-dumping.test.ts) |
| **AML.T0098** | AI Agent Tool Credential Harvesting (added ATLAS 2026 / v5.4.0) | An agent uses its tools (file reads, shell) to harvest credentials and surface them. Layered defense: (1) nothing to harvest — credentials never enter the agent process (see T0090); (2) per-tool-call broker materialization with a TTL instead of a long-lived export; (3) the post-tool-output redactor scrubs both secret-shaped strings and the verbatim injected values before they can reach a transcript. The `aquaman-coder` PreToolUse hook additionally blocks reads of `.env*`, `*.pem`, `id_rsa`, `.aws/credentials`, `.ssh/*`. | [`test/compliance/atlas/t0098-credential-harvesting.test.ts`](../../test/compliance/atlas/t0098-credential-harvesting.test.ts) |

## What this is not

- Not an official ATLAS certification (ATLAS is a catalog, not a conformance program).
- Not a complete defense against the techniques — see "Limits" below.

## Limits

- **AML.T0055:** Vault backends themselves can be compromised. Aquaman shifts the trust boundary from agent process → vault; it doesn't eliminate it.
- **AML.T0012:** Policy rules are operator-defined. A misconfigured allow-everything policy leaves the path open. `aquaman doctor` validates the policy config but cannot validate intent.
- **AML.T0062:** Header-stripping covers `Authorization` and `X-API-Key`. Other auth schemes (cookies, custom headers, query-string-embedded tokens) flow through untouched and rely on the policy engine.
- **AML.T0090:** The broker endpoint materializes credentials in the agent shell's env for the duration of the tool call. That's still a non-zero window where the credential exists outside the proxy. The consumer's responsibility is to scrub after.
- **AML.T0098:** The redactor is pattern- and value-based. A secret the agent transforms (base64, splits across lines, re-encodes) before surfacing it can evade pattern matching; the verbatim-value scrub only covers values aquaman itself injected. Layer 1 (isolation) is the real mitigation — redaction is defense-in-depth, not a guarantee.

## References

- ATLAS Matrix: https://atlas.mitre.org/matrices/ATLAS
- ATLAS Technique IDs cited above are stable across v5.x releases.
- For a machine-readable evidence report keyed by technique ID, run `vitest run test/compliance/atlas/ --reporter=json`.
