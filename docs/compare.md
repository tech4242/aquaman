# aquaman compared with other ways to keep credentials from AI agents

Most agent hosts now ship some form of credential protection, and several dedicated tools exist. This page says where aquaman fits and where something else is the better choice. Facts about other projects are from their own documentation and source, read on 2026-11-16 (fnox and nono on 2026-11-18); if something here is wrong or out of date, please open an issue.

## Two mechanisms, and which one you get

Every tool on this page does one of two things, and the difference matters more than any feature list.

- **Injected at egress.** The agent and the programs it runs hold a placeholder. A proxy outside them swaps in the real value on the way to the API. The secret is never in the process that could leak it.
- **Injected into the environment.** The program is started with the real value in an environment variable. The agent's conversation does not see it, and output can be masked, but the program holds the secret and can do anything with it.

aquaman does both, depending on the path:

| aquaman path | Mechanism |
|---|---|
| OpenClaw, Hermes model calls, any client you point at the proxy (`/<service>/...`) | At egress. Request policies apply here |
| NVIDIA OpenShell driver, Docker Sandboxes credential helper | aquaman supplies the value to the host; the host injects at egress |
| Claude Code and Codex (`aquaman-coder`), default | Into the environment of each command, with output redaction. Request policies do not apply |
| Claude Code and Codex, a binding made with `--via-proxy` | At egress: the app holds a local token and the proxy's URL. Request policies apply. Needs an app that takes a base URL ([guide](app-through-proxy.md)) |

So for a coding agent building an ordinary app that reads `GITHUB_TOKEN` from its environment, aquaman is in the same class as `op run` and `doppler run`: the app holds the key while it runs. The app itself is written the same way with any of them, or with none; the choice is only about how the variable gets set on the developer's machine. What differs is that aquaman needs no account, takes the value from whichever vault you already use, lets the agent ask for a key it does not have, and keeps a local record of each use. If you need the app itself never to hold it, [route it through the aquaman proxy](app-through-proxy.md), which works for any HTTP API whose client accepts a base URL, or use a tool that intercepts HTTPS for arbitrary commands (fnox, Claude Code's sandbox masking), which needs no cooperation from the app but puts a local certificate authority in the path.

## At a glance

| | Mechanism for a coding agent's commands | Where the secret is kept | Account needed | Record of each use |
|---|---|---|---|---|
| **aquaman** | Environment, per command, output redacted. At egress, with request policies, for an app given the proxy's URL (`--via-proxy`) | The vault you already use: Keychain, 1Password, Bitwarden, HashiCorp Vault, KeePassXC, Keeper, systemd-creds, or an encrypted file. A reference can point at an item you already have | No | Hash-chained log on your machine, with its last position anchored in your vault |
| 1Password `op run` and Environments | Environment, output masked | 1Password | 1Password | On the 1Password account side (usage reports, Events API); not examined in detail |
| fnox `proxy run` | At egress, for hosts you write a rule for, through a local HTTPS proxy with its own certificate authority; can also run the command in an OS sandbox so the proxy is its only way out | Providers you configure: its documentation lists about thirty, among them the system keychain, 1Password, Bitwarden, HashiCorp Vault and KeePass | No | Log of method, host, path and secret name per request; no integrity protection described |
| nono | At egress, through a local proxy the agent reaches by base URL with a session token, or by TLS interception; runs the agent in an OS sandbox. Signs AWS requests. An environment mode exists too | OS keychain or Secret Service, 1Password, Bitwarden, Apple Passwords, a file, or a command | No | Per-session log with a hash chain and Merkle root, checked by `nono audit verify`, optionally signed; its documentation does not say whether each credential use is an event |
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

- Your secrets already live in a password manager or vault and you do not want a second copy or a new account. A reference can point at the item you already have, and you approve that in a dialog.
- You want the agent to set things up and ask for credentials itself, without ever handling one: `aquaman init --agent` and `aquaman request` are built for that, with no prompts, JSON output, and a native dialog where a person supplies each value. (fnox has a comparable request flow through its MCP server, off by default, where the person enters the value on a local web page.)
- You use more than one agent host (say Claude Code, OpenClaw and an OpenShell sandbox) and want one place that holds the keys and one record of their use.
- You want evidence: every use is written to a log whose entries are numbered and chained by SHA-256, and the log's last position is kept in your vault, so an altered or inserted entry and a truncated or replaced log are detectable (`aquaman audit verify`). The limits are under "What aquaman does not do".
- You route OpenClaw, Hermes or your own client through the proxy and want to limit what a key can do there, per endpoint (`aquaman policy`).

## Choose something else when

- **You already pay for 1Password and only need environment variables for local commands.** `op run` does that with a mature product behind it. If you later want the log or the agent-run setup, aquaman can use 1Password as its vault, and a reference can point at the 1Password item you already have (`aquaman request <ref> --from 'op://<vault>/<item>/<field>'`), so nothing is copied out of it. For the commands themselves the protection is the same as `op run`: the command holds the value while it runs.
- **The program must never hold the key, for any API.** fnox `proxy run` injects at egress for any HTTPS host you write a rule for, by terminating TLS locally. It also needs no account and reads from vaults you already have. It can also confine the command in an OS sandbox so the proxy is the only way out, and mint short-lived credentials at the proxy. aquaman does it without a certificate authority, for services it has a definition for (27 built in, others in `services.yaml`) and apps that accept a base URL.
- **You want the agent itself boxed in, not only its keys.** nono runs the agent in a kernel sandbox and injects credentials at a local proxy from your keychain, 1Password or Bitwarden. It also injects into query strings, which aquaman does not do. Both sign AWS requests at the proxy; aquaman does it for an AWS client that takes its endpoint from the environment ([guide](aws.md)). aquaman has no sandbox: it works with the one your agent host provides.
- **You only use Claude Code, with its sandbox on.** Its credential masking is built in and needs no separate tool.
- **You only use Docker Sandboxes and the OS keychain is enough.** It does the injection itself; aquaman only adds other vaults and a log entry per read.
- **Your team already runs Doppler or Infisical.** Secrets shared across a team, CI and production belong there. aquaman is a local tool for one person's machine and has no team sync.
- **You need per-user OAuth consent to SaaS APIs across an organisation.** That is an identity-provider problem.
- **You need a process-level boundary between the agent and everything else running as you.** aquaman does not provide one: see the limits below.
- **You want the most widely used option.** aquaman is not that; what it is and how to check it are in the next section.

## What to know before trusting it

What you can check yourself:

- **It was one of the first tools to inject credentials at egress for AI agents.** The first release, on 6 February 2026, was the proxy and the OpenClaw plugin. By the public history of the other projects on this page, nono's proxy gained credential injection on 23 February 2026, the OpenShell repository was created on 24 February, OneCLI's on 8 March and Infisical Agent Vault's on 27 March. Claude Code followed in 0.12.0, Hermes in 0.13.0, Codex in 0.16.0 and NVIDIA OpenShell in 0.17.0. There were 40 releases up to 0.21.0, each on npm with its date (`npm view aquaman-proxy time`) and described in the [changelog](changelog.md).
- **Releases are verifiable.** npm packages are published from GitHub Actions with provenance, shown on each version's npm page; `npm audit signatures` checks it in a project that installs them. No install scripts.
- **It is local and inspectable.** No account, no telemetry, no network service of its own. Config and logs are plain files under `~/.aquaman`.
- **The tests are in the repository, and CI holds a coverage floor.** More than 3,200 tests (`npx vitest list` counts them). Line coverage is measured over everything that ships, including both command-line tools and the processes the tests start, and CI fails below 95% overall and for each package. Five files have higher floors: the request-target parser 100%, the broker scope, the request policy and the credential dialog 98%, the daemon 97% (`scripts/coverage-floors.json`).
- **The security tests attack each control, and the limits are pinned.** The tests under `test/compliance/` are written one table row per attack: respelling a request to get past a deny rule, sending raw bytes at the request parser, tampering with the audit log, comparing each dialog's wording with what a caller can then obtain. An attack the code does not stop stays in the table as a row that is expected to fail and says so in its name (`grep -rn "it.fails" test/compliance` lists them), and the [mapping pages](compliance/nist-800-53.md) state the same limits. The day one is fixed, its row fails and has to be updated.
- **What a review found is in the changelog.** Before 0.18.2 the code was assessed against OWASP ASVS 5.0, the OWASP Top 10 lists for agentic and LLM applications, the OWASP API Security Top 10, NIST SP 800-53, NIST SSDF and BSI TR-02102-1. The findings were fixed in that release, each with a test that fails without the fix, and are listed with what to check on your own machine: [0.18.2](changelog.md#0182). That was the project's own work, not an outside audit.
- **It has a public OpenSSF Scorecard.** Scorecard is the Open Source Security Foundation's automated check of how a repository is kept: pinned dependencies, workflow permissions, static analysis, open vulnerabilities, branch protection and more. aquaman's result is recomputed on every change to `main` and published at [scorecard.dev](https://scorecard.dev/viewer/?uri=github.com/tech4242/aquaman). The project also holds the OpenSSF [Best Practices badge](https://www.bestpractices.dev/projects/17039) at the passing level, a public self-assessment against 67 criteria with each answer shown. Run by us with Scorecard 5.7.0 on 2026-11-23, aquaman scored 7.4 out of 10, the highest of the five dedicated tools on this page whose source is on GitHub, and it was the only one of them with a published result.
- **Security issues are published by the project.** Its own adversarial testing of the request path found one high-severity issue, [GHSA-9qh6-wffq-9m9v](https://github.com/tech4242/aquaman/security/advisories/GHSA-9qh6-wffq-9m9v): until 0.17.2 a crafted request path could make the proxy send a stored credential to another host. It was fixed in 0.17.2 and published as an advisory; no use of it has been reported. The request path now has a conformance suite that sends raw bytes at a real proxy (`test/compliance/request-target-integrity.test.ts`). Use 0.17.2 or later.

It is maintained by one person, and the reviews described above are the project's own: there has been no third-party audit.

## What aquaman does not do

- It is not a sandbox. It keeps credentials away from the agent; it does not confine what the agent runs.
- Any process running as your user can send requests through the proxy, within your policy, and can fetch references you declared. The audit log records it.
- The audit log is anchored in your vault at most once a minute (every 15 minutes with 1Password, Bitwarden or Keeper), not per entry. `aquaman audit verify` detects an entry altered, inserted or deleted inside the log, and a log cut short, emptied, deleted or rebuilt; it does not detect the removal of entries written since the last anchor, or a change made by software that can also write to the vault.
- On the coding-agent path the wrapped command receives the real value for its lifetime. Output redaction catches accidental exposure, not a command that deliberately transforms the value.
- The proxy only sees traffic from clients that can be pointed at it, for services it has a definition for (27 are built in; others are added in `services.yaml`).
- No Windows support outside WSL2. No team sharing, and it does not run in CI or production. An app that reads its keys from the environment needs nothing from aquaman there: the same variable names are filled from that platform's secrets.

Security policy and past advisories: [SECURITY.md](../SECURITY.md), [advisories](https://github.com/tech4242/aquaman/security/advisories).
