# Agentic AI Security Guidance

Aquaman aligns with multiple 2026 industry guidances on agentic AI security. These are documentary frameworks (no conformance programs), so claim **alignment** with specific recommendations, not certification.

## CISA / NSA / Five-Eyes — "Careful Adoption of Agentic AI Services" (April 2026)

> Joint guidance from CISA + NSA + UK NCSC + Canada CCCS + Australia ACSC + New Zealand NCSC. Published 2026-04-30.
>
> Source: https://media.defense.gov/2026/Apr/30/2003922823/-1/-1/0/CAREFUL%20ADOPTION%20OF%20AGENTIC%20AI%20SERVICES_FINAL.PDF

| Recommendation theme | Aquaman alignment |
|---|---|
| **Incremental deployment** | Aquaman ships as a plugin / adapter that can be added to existing agent setups without re-architecting. `aquaman doctor` validates the integration before any credential flows. |
| **Strong governance** | Hash-chained audit log records every credential access, every policy decision, every broker resolve. Tamper-evident chain provides governance-grade evidence trail. |
| **Continuous monitoring** | Per-credential-access audit events with timestamp, service, method, path, outcome. `aquaman audit tail` for live monitoring. |
| **Supply-chain controls** | Aquaman pins its own dependencies exactly (no semver ranges on `aquaman-proxy` from `aquaman-plugin` or `aquaman-coder`). Versions cross-pin between packages. ClawScan + VirusTotal third-party audit posture: Passed. |
| **Expanded attack surface mitigation** | Process isolation: credentials live in a separate proxy process, not in the agent's address space. UDS-only socket (chmod 0o600), no network exposure. |
| **Privilege creep prevention** | Broker endpoint materializes credentials per tool call (default 60s TTL, max 3600s). Agent's shell holds the credential only for the duration of one command. Project-scoped credential maps (v0.12.0+) limit which services each project sees. |
| **Obscure event records (anti-tampering)** | Hash-chained audit log makes mutation, insertion, or deletion of entries detectable via `AuditLogger.verifyIntegrity()`. |

## CSA MAESTRO — Multi-Agent Environment, Security, Threats, Risks & Outcomes

> Cloud Security Alliance's seven-layer threat-modeling framework for agentic AI systems.
>
> Source: https://github.com/CloudSecurityAlliance/MAESTRO

CSA's own MAESTRO commentary explicitly endorses the **ephemeral credential broker model** — credentials issued at execution time, scoped per task. That is a near-literal description of aquaman's broker endpoint.

| MAESTRO Layer | Aquaman feature |
|---|---|
| **L2 Data Operations** | Vault backends + secret-pattern redactor (incoming + outgoing data sanitization). |
| **L3 Agent Framework** | HTTP interceptor strips `Authorization` and `X-API-Key` headers before routing — credentials don't leak from agent SDKs that preset them. |
| **L4 Deployment Infrastructure** | UDS-only socket, file-mode access control, no network exposure. |
| **L5 Evaluation & Observability** | Hash-chained audit log; runnable conformance tests at `test/compliance/`. |
| **L6 Security & Compliance** | This document set: MITRE ATLAS + NIST SP 800-53 mappings + this guidance alignment. |
| **L7 Agent Ecosystem** | Per-agent adapters (OpenClaw shipping; Claude Code via `aquaman-coder` in v0.12.0; Codex / OpenCode / Cursor coming) — the same vault, audit, and policy engine across every supported agent. |

## OWASP Top 10 for Agentic Applications (canonical Dec 2025 list)

> Source: https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/

Aquaman aligns with several ASI categories. The canonical "OWASP Top 10 for Agentic Applications for 2026" (published 2025-12-09) is the stable reference; in it **ASI04 = Agentic Supply Chain Vulnerabilities**. We map to ASI02, ASI03, and ASI04 where the alignment is concrete.

| ASI Category | Aquaman alignment |
|---|---|
| **ASI02** Tool Misuse | HTTP interceptor scope is operator-controlled via `services` config (v0.11.4+). Channels not in `services` keep their direct-to-upstream behavior — no over-broad redirect. |
| **ASI03** Agent Identity & Privilege Abuse | `autoGenerateAuthProfiles: false` opt-out (v0.11.4+) for operators managing their own auth. Spawn env narrowed to an explicit allowlist (v0.11.5+) so the proxy process doesn't inherit arbitrary parent secrets. Broker endpoint (v0.12.0+) for per-call materialization. |
| **ASI04** Agentic Supply Chain Vulnerabilities | Aquaman cross-pins its own packages exactly (no semver ranges between `aquaman-proxy` / `aquaman-plugin` / `aquaman-coder`); ClawScan + VirusTotal posture: Passed. Relevant to the 2026 npm-worm wave (Shai-Hulud / Miasma) that harvests AI-agent configs: credentials are never written into `~/.claude/settings.json` or agent config (only the hook command is), so a config-stealing worm finds no secrets there. **Gap:** aquaman does not detect tampering of its own hook entries yet — `aquaman doctor` hook-drift detection is tracked for a future release (see ROADMAP.md). |

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
- OWASP GenAI Top 10 for Agentic Applications: https://genai.owasp.org/
- NIST CAISI: https://www.nist.gov/caisi/ai-agent-standards-initiative
