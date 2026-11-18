# Agentic AI Security Guidance

How aquaman relates to 2026 guidance on agentic AI security. These are documentary frameworks with no conformance programs, so nothing here is a certification. The CISA and CSA sections are alignment narratives; the OWASP section links each claim to a test.

## CISA / NSA / Five-Eyes — "Careful Adoption of Agentic AI Services" (April 2026)

> Joint guidance from CISA + NSA + UK NCSC + Canada CCCS + Australia ACSC + New Zealand NCSC. Published 2026-04-30.
>
> Source: https://media.defense.gov/2026/Apr/30/2003922823/-1/-1/0/CAREFUL%20ADOPTION%20OF%20AGENTIC%20AI%20SERVICES_FINAL.PDF

| Recommendation theme | aquaman alignment |
|---|---|
| **Incremental deployment** | aquaman ships as a plugin / adapter that can be added to existing agent setups without re-architecting. `aquaman doctor` validates the integration before any credential flows. |
| **Strong governance** | A hash-chained audit log records every credential use, policy denial and broker read; a value is not handed out unless its entry was written. What the chain and its anchor detect and what they do not is stated under AU-9 in the [NIST mapping](nist-800-53.md). |
| **Continuous monitoring** | Per-credential-access audit events with timestamp, service, operation and outcome. `aquaman audit tail` for live monitoring. |
| **Supply-chain controls** | aquaman pins its own dependencies exactly (no semver ranges on `aquaman-proxy` from `aquaman-plugin` or `aquaman-coder`). Versions cross-pin between packages. ClawScan + VirusTotal third-party audit posture: Passed. |
| **Expanded attack surface mitigation** | Process isolation: credentials live in a separate proxy process, not in the agent's address space. UDS-only socket (chmod 0o600), no network exposure. |
| **Privilege creep prevention** | Broker endpoint materializes credentials per tool call (default 60s TTL, max 3600s). Agent's shell holds the credential only for the duration of one command. Project-scoped credential maps (v0.12.0+) limit which services each project sees. |
| **Obscure event records (anti-tampering)** | `aquaman audit verify` detects an entry altered, inserted or deleted inside the log through the hash chain, and a log cut short, emptied, deleted or rebuilt through the anchor the serving process keeps in the credential store. Not detected: the removal of entries written since the last anchor (at most `audit.anchorIntervalSeconds`: 60 by default, 900 with 1Password, Bitwarden or Keeper), and a change made by software that can also write to the credential store. Details under AU-9 in the [NIST mapping](nist-800-53.md#the-audit-logs-anchor). |

## CSA MAESTRO — Multi-Agent Environment, Security, Threats, Risks & Outcomes

> Cloud Security Alliance's seven-layer threat-modeling framework for agentic AI systems.
>
> Source: https://github.com/CloudSecurityAlliance/MAESTRO

CSA's own MAESTRO commentary explicitly endorses the **ephemeral credential broker model** — credentials issued at execution time, scoped per task. That is a near-literal description of aquaman's broker endpoint.

| MAESTRO Layer | aquaman feature |
|---|---|
| **L2 Data Operations** | Vault backends + secret-pattern redactor (incoming + outgoing data sanitization). |
| **L3 Agent Framework** | HTTP interceptor strips `Authorization` and `X-API-Key` headers before routing — credentials don't leak from agent SDKs that preset them. |
| **L4 Deployment Infrastructure** | UDS-only socket, file-mode access control, no network exposure. |
| **L5 Evaluation & Observability** | Hash-chained audit log; runnable conformance tests at `test/compliance/`. |
| **L6 Security & Compliance** | This document set: MITRE ATLAS, NIST SP 800-53 and BSI TR-02102-1 mappings, and this page. |
| **L7 Agent Ecosystem** | Per-agent adapters (OpenClaw shipping; Claude Code via `aquaman-coder` since v0.12.0, Codex since v0.16.0): the same vault, audit, and policy engine across every supported agent. |

## OWASP Top 10 for Agentic Applications 2026 and Top 10 for LLM Applications 2025

> Sources: [OWASP Top 10 for Agentic Applications for 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) (Version 2026, December 2025) and [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/).

Only the categories aquaman makes a claim under are listed. Each claim names the test that tries to break it; a row marked *aligned* has no test of its own. Prompt injection and goal hijack (LLM01, ASI01) are not controls aquaman has: it limits what a hijacked agent can obtain.

| Category | What aquaman claims | Test |
|---|---|---|
| **ASI02** Tool Misuse and Exploitation, **LLM06:2025** Excessive Agency | A credential request never returns a value and never replaces a stored one; one dialog at a time and at most six in ten minutes; a declined reference is not asked about again for ten minutes; requests are accepted on the Unix socket only. The hook answers `allow` only when one of the project's references resolves. A deny rule in request policy holds against respellings of the path and the method. | [`credential-request.test.ts`](../../test/compliance/credential-request.test.ts), [`coder-hook.test.ts`](../../test/unit/coder-hook.test.ts), [`policy-evasion.test.ts`](../../test/compliance/policy-evasion.test.ts) (four spellings are `it.fails` rows) |
| **ASI03** Identity and Privilege Abuse | The broker hands out declared references only, checked before the vault; OpenClaw-hosted proxies hand out none; LLM provider keys are never materialized over loopback. A routed program's token forwards requests to routed services and is refused by every broker endpoint. | [`broker-scope.test.ts`](../../test/compliance/broker-scope.test.ts), [`app-route.test.ts`](../../test/compliance/app-route.test.ts) |
| **ASI04** Agentic Supply Chain Vulnerabilities, **LLM03:2025** Supply Chain | Packages cross-pin each other exactly; the KeePassXC and gRPC dependencies are optional peers, loaded only when used; the OpenClaw gateway is not in the lockfile. Releases are published from CI with provenance. Credentials are never written into `~/.claude/settings.json` or agent config (only the hook command is), so a config-stealing package finds no secrets there. | [`packaging-posture.test.ts`](../../test/unit/packaging-posture.test.ts) for the dependency claims; the rest *aligned* |
| **ASI09** Human-Agent Trust Exploitation | The credential dialog says what the caller can obtain once the person agrees: after an ordinary request the value is handed to commands, and the dialog says so; after a routed request the broker refuses the reference, and the dialog says the app gets a token and not the key. Caller-supplied text is one bounded line after aquaman's own sentences and cannot change them. | [`asi09-human-in-the-loop.test.ts`](../../test/compliance/owasp-agentic/asi09-human-in-the-loop.test.ts) |
| **LLM02:2025** Sensitive Information Disclosure | On the proxy paths the program holds a placeholder or a local token and never the key. On the coding-agent path the command holds the value and its output is redacted: the injected value in the form it was given, in the shapes ordinary tools print it in, and split across chunks. Not redacted: a base64 encoding of the value, and a value with colour codes inside it. | [`llm02-output-redaction.test.ts`](../../test/compliance/owasp-agentic/llm02-output-redaction.test.ts) (the two misses are `it.fails` rows), [`t0055-unsecured-credentials.test.ts`](../../test/compliance/atlas/t0055-unsecured-credentials.test.ts) |

## NIST CAISI — AI Agent Standards Initiative

> Announced February 2026 by NIST's Center for AI Standards and Innovation.
>
> Source: https://www.nist.gov/caisi/ai-agent-standards-initiative

No published specification yet (as of 2026-06-16). The concrete deliverable in flight is **COSAiS — "SP 800-53 Control Overlays for Securing AI Systems"** (single-agent and multi-agent use cases), still in development. We track for when the overlay lands — at which point this doc gains another mapping section.

## What this is not

- Not a regulatory certification — these are advisory documents, not conformance programs.
- Not exhaustive — there are many agentic-AI guidances; we map to the ones that cite-back to aquaman's actual feature set.
- Not transitive — aquaman doesn't automatically make a downstream system "EU AI Act compliant" or "FedRAMP-ready." It contributes evidence to those programs; the system-level evaluation remains the operator's responsibility.

## References

- CISA "Careful Adoption of Agentic AI Services" (April 2026): https://media.defense.gov/2026/Apr/30/2003922823/-1/-1/0/CAREFUL%20ADOPTION%20OF%20AGENTIC%20AI%20SERVICES_FINAL.PDF
- CSA MAESTRO: https://github.com/CloudSecurityAlliance/MAESTRO
- OWASP Top 10 for Agentic Applications for 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- OWASP Top 10 for LLM Applications 2025: https://genai.owasp.org/llm-top-10/
- NIST CAISI: https://www.nist.gov/caisi/ai-agent-standards-initiative
