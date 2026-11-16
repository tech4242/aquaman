# aquaman compared with other ways to keep credentials from AI agents

Most agent hosts now ship some form of credential protection, and several dedicated tools exist. This page says where aquaman fits and where something else is the better choice. Facts about other projects are from their own documentation and source, read on 2026-11-16; if something here is wrong or out of date, please open an issue.

## Two mechanisms, and which one you get

Every tool on this page does one of two things, and the difference matters more than any feature list.

- **Injected at egress.** The agent and the programs it runs hold a placeholder. A proxy outside them swaps in the real value on the way to the API. The secret is never in the process that could leak it.
- **Injected into the environment.** The program is started with the real value in an environment variable. The agent's conversation does not see it, and output can be masked, but the program holds the secret and can do anything with it.

aquaman does both, depending on the path:

| aquaman path | Mechanism |
|---|---|
| OpenClaw, Hermes model calls, any client you point at the proxy (`/<service>/...`) | At egress. Request policies apply here |
| NVIDIA OpenShell driver, Docker Sandboxes credential helper | aquaman supplies the value to the host; the host injects at egress |
| Claude Code and Codex (`aquaman-coder`) | Into the environment of each command, with output redaction. Request policies do not apply |

So for a coding agent building an ordinary app that reads `GITHUB_TOKEN` from its environment, aquaman is in the same class as `op run` and `doppler run`: the app holds the key while it runs. If you need the app itself never to hold it, use a tool that injects at egress for arbitrary commands (fnox, Claude Code's sandbox masking), or point the app's HTTP client at the aquaman proxy for the services it knows.

## At a glance

| | Mechanism for a coding agent's commands | Where the secret is kept | Account needed | Record of each use |
|---|---|---|---|---|
| **aquaman** | Environment, per command, output redacted. At egress for clients pointed at the proxy | The vault you already use: Keychain, 1Password, Bitwarden, HashiCorp Vault, KeePassXC, Keeper, systemd-creds, or an encrypted file | No | Hash-chained log on your machine |
| 1Password `op run` and Environments | Environment, output masked | 1Password | 1Password | On the 1Password account side (usage reports, Events API); not examined in detail |
| fnox `proxy run` | At egress, for hosts you write a rule for, through a local HTTPS proxy with its own certificate authority | Providers you configure, such as 1Password, the system keychain or age | No | Optional log of method, host, path and secret name |
| dotenvx | Environment; the agent process itself is started with the real values, output redacted | Encrypted `.env` files in the repository, key kept separately | No | None in the open-source CLI; audit logs are listed for its paid hosted plans |
| Doppler | Environment, into the agent process at launch | Doppler | Doppler | "Every secret access is logged" |
| Claude Code sandbox credentials (built in) | At egress in `mask` mode, which needs the sandbox and the experimental `network.tlsTerminate` setting | Environment variables and files on the machine | No | None documented |
| Codex credential masking (built in) | At egress. Under development and off by default | Environment variables and files on the machine | No | Not examined |
| Docker Sandboxes (built in) | At egress, for agents running inside a sandbox | OS keychain, or a command you configure | Docker sign-in | Not examined |
| NVIDIA OpenShell (built in) | At egress, for agents running inside a sandbox | Its own store or an external driver | No | Event log (OCSF); no per-credential record documented |
| Infisical Agent Vault | At egress, through its proxy | Infisical (the platform product, in preview). The standalone open-source repository's README now points new users to the platform product | Infisical | Not examined |
| OneCLI | At egress, through its gateway | Its own store, Bitwarden or 1Password | Not examined | Not examined |

"Not examined" means we did not verify it, not that the feature is missing.

## Choose aquaman when

- Your secrets already live in a password manager or vault and you do not want a second copy or a new account.
- You want the agent to set things up and ask for credentials itself, without ever handling one: `aquaman init --agent` and `aquaman request` are built for that, with no prompts, JSON output, and a native dialog where a person supplies each value. (fnox has a comparable request flow through its MCP server, off by default, where the person enters the value on a local web page.)
- You use more than one agent host (say Claude Code, OpenClaw and an OpenShell sandbox) and want one place that holds the keys and one record of their use.
- You want evidence: every use is written to a log whose entries are chained by SHA-256, so tampering is detectable (`aquaman audit verify`).
- You route OpenClaw, Hermes or your own client through the proxy and want to limit what a key can do there, per endpoint (`aquaman policy`).

## Choose something else when

- **You already pay for 1Password and only need environment variables for local commands.** `op run` does that with a mature product behind it. aquaman can use 1Password as its vault if you later want the log or the agent-run setup.
- **The program must never hold the key, for any API.** fnox `proxy run` injects at egress for any HTTPS host you write a rule for, by terminating TLS locally. It also needs no account and reads from vaults you already have. aquaman's proxy does this only for services it has a definition for and clients you can point at it.
- **You only use Claude Code, with its sandbox on.** Its credential masking is built in and needs no separate tool.
- **You only use Docker Sandboxes and the OS keychain is enough.** It does the injection itself; aquaman only adds other vaults and a log entry per read.
- **Your team already runs Doppler or Infisical.** Secrets shared across a team, CI and production belong there. aquaman is a local tool for one person's machine and has no team sync.
- **You need per-user OAuth consent to SaaS APIs across an organisation.** That is an identity-provider problem.
- **You need a process-level boundary between the agent and everything else running as you.** aquaman does not provide one: see the limits below.
- **You want the most widely used option.** aquaman is a young, small project; the facts are in the next section.

## What to know before trusting it

- **One maintainer, no third-party audit.** Started in February 2026, still 0.x.
- **It has had a serious bug.** [GHSA-9qh6-wffq-9m9v](https://github.com/tech4242/aquaman/security/advisories/GHSA-9qh6-wffq-9m9v) (high): until 0.17.2 a crafted request path could make the proxy send a stored credential to another host. It was found by the project's own adversarial testing, fixed, and disclosed with an advisory. The request path now has a conformance suite that sends raw bytes at a real proxy (`test/compliance/request-target-integrity.test.ts`). Use 0.17.2 or later.
- **Releases are verifiable.** npm packages are published from GitHub Actions with provenance, shown on each version's npm page; `npm audit signatures` checks it in a project that installs them. No install scripts.
- **It is local and inspectable.** No account, no telemetry, no network service of its own. Config and logs are plain files under `~/.aquaman`.

## What aquaman does not do

- It is not a sandbox. It keeps credentials away from the agent; it does not confine what the agent runs.
- Any process running as your user can send requests through the proxy, within your policy, and can fetch references you declared. The audit log records it.
- On the coding-agent path the wrapped command receives the real value for its lifetime. Output redaction catches accidental exposure, not a command that deliberately transforms the value.
- The proxy only sees traffic from clients that can be pointed at it, for services it has a definition for (25 are built in; others are added in `services.yaml`).
- No Windows support outside WSL2. No team sharing, CI or production story: use your existing secrets manager there.

Security policy and past advisories: [SECURITY.md](../SECURITY.md), [advisories](https://github.com/tech4242/aquaman/security/advisories).
