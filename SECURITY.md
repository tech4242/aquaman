# Security Policy

Aquaman is a credential-isolation proxy — security reports get priority over everything else.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Use GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/tech4242/aquaman/security/advisories/new)** (Security tab → "Report a vulnerability")

You can expect an acknowledgement within **7 days**. For confirmed vulnerabilities in shipped code, the fix and the release ship in one motion (so the fix is not visible in the public history ahead of a patched version), followed by a GitHub security advisory crediting the reporter (unless you prefer otherwise). There is no bug bounty.

## Supported versions

| Version | Supported |
|---|---|
| Latest minor of the 0.x line (all packages) | ✅ |
| Anything older | ❌ — upgrade first |

The four packages (`aquaman-proxy`, `aquaman-plugin`, `aquaman-coder` on npm; `aquaman-hermes` on PyPI) are released in lockstep; a fix bumps all of them.

## Scope

**In scope:** anything that breaks aquaman's stated guarantees —

- Credential exposure to the agent process (values reaching the agent's memory, transcript, or environment outside the documented broker flow)
- Bypasses of the request-policy engine, the loopback token gate, or UDS/file permissions
- Audit-log tampering that `verifyIntegrity()` fails to detect
- Vulnerabilities in the packages' own code or their published artifacts (including the release pipeline)

**Out of scope:**

- Vulnerabilities in the vault backends themselves (1Password, Bitwarden, HashiCorp Vault, KeePassXC, OS keychains, systemd) — report those upstream
- Vulnerabilities in the agent hosts (OpenClaw, Claude Code, Hermes) — report those upstream
- Prompt-injection *content* attacks against the agent. Note the design boundary: **aquaman prevents credential exfiltration, not credential use.** A prompt-injected agent running as the same OS user can call the same proxy the legitimate code calls; the request-policy engine is the control that limits what a used credential can do. Reports that reduce to "the agent can use the proxy" are the documented threat model, not a vulnerability — but bypasses *of the policy engine itself* are very much in scope.
- Redaction misses for secrets aquaman did not inject (the redactor is documented as defense-in-depth, not a guarantee)

## Where the security documentation lives

This file is the **process**: how to report, what's supported. It intentionally makes no design claims of its own. For those:

- **Design** — the security model in the [README](README.md#security-model-in-depth) (process isolation, request policies, tamper-evident audit, credential caching trade-offs)
- **Control evidence** — [`docs/compliance/`](docs/compliance/): MITRE ATLAS and NIST SP 800-53 mappings, each claim backed by a runnable conformance test under [`test/compliance/`](test/compliance/) (`npx vitest run test/compliance/`)

If this file and those documents ever disagree, those documents win — and please report the discrepancy.
