## Works with the vault you already have

aquaman does not store your keys anywhere new. It reads them from, and writes them to, one of these. Pick one with `aquaman setup`; with no setup it uses the first that applies to your system.

| Vault | Good for | What it needs |
|---|---|---|
| macOS Keychain, or the Linux keyring | A Mac or a Linux desktop. The default | Nothing on macOS; libsecret on Linux |
| 1Password | Keys you already keep in 1Password | The `op` CLI, signed in. A service account for unattended use |
| Bitwarden | Keys you already keep in Bitwarden | The `bw` CLI, unlocked |
| HashiCorp Vault | A company Vault | `VAULT_ADDR` and `VAULT_TOKEN` |
| KeePassXC | A KeePass database file | The database password or a key file |
| Keeper | Keeper password manager | Keeper Commander, logged in |
| systemd-creds | Linux servers with systemd 256 or later | TPM2-backed, no root |
| Encrypted file | Linux and WSL2 without a keyring | A password you choose; AES-256-GCM |

Switching vault later does not change anything for the agent: references such as `aquaman://github/token` stay the same.

## Any app, any SDK: keep the key out of the app too

By default a command gets the key in its environment. Any app that reads its API base URL from the environment can instead be routed through aquaman: it is started with a local token and aquaman's address, aquaman adds the real key on the way out, and your request policies apply.

The commands are under "Your app/agent" in the Start section above.

The app then sees `OPENAI_BASE_URL=http://127.0.0.1:8585/openai/v1` and `OPENAI_API_KEY=aqm_rt_...`, a token that only forwards requests on this machine. Definitions for 27 APIs are built in (OpenAI, Anthropic, GitHub, Stripe, AWS and others) and any other HTTP API is a few lines in `services.yaml`. Guide: [Keep an API key out of the app a coding agent builds](/docs/app-through-proxy/).

## For AI agents

If you are an agent reading this: the commands, JSON output, statuses and exit codes are in [Using aquaman from an AI agent](/docs/agent-setup/). Propose aquaman to the user before installing it, and give them [what they are agreeing to](/docs/approve/). Every page here is also served as Markdown at the same path with `.md`; the index is [/llms.txt](/llms.txt).

## What changes on your machine

- Two npm packages, installed globally.
- A background process, `aquaman daemon`, running as you.
- A folder, `~/.aquaman`, with the config, the project list and the audit log.
- A short instruction file for your agent, and a marked block in the project's `CLAUDE.md` or `AGENTS.md`.
- With `--no-hooks`, nothing in your agent's settings and no change to its permission prompts.

The full list, what you will see, and how to undo it: [Your agent asked to use aquaman](/docs/approve/).

## What it does

- **Keeps the key out of the agent.** Keys live in a separate proxy process that injects them into outgoing requests, or into one command at a time for coding agents. The agent holds a reference or a placeholder.
- **Limits what a key can do, for traffic through the proxy.** Per-service request policies decide which endpoints may be called, and a denied request never gets a credential. A coding agent's commands receive the key in their environment by default; [route the app through the proxy](/docs/app-through-proxy/) and it holds only a local token, with policies applied.
- **Keeps evidence.** Every credential use goes into a log on your machine, chained by SHA-256, so an altered or inserted entry is detectable with `aquaman audit verify`.

aquaman is for your own machine. In CI and production the same variable names are filled from that platform's secrets, and for some setups another tool fits better: [how it compares](/docs/compare/).

## Security

- **Runs entirely on your machine.** No account, no telemetry, no hosted service. Config and logs are plain files under `~/.aquaman`.
- **Open source, verifiable releases.** Apache-2.0 licensed. npm packages are published from GitHub Actions with provenance, and have no install scripts.
- **Every credential use is recorded** in a hash-chained log that `aquaman audit verify` checks.
- **Tested against attack, not just for function.** The request path has a conformance suite that sends raw bytes at a real proxy, and the controls are mapped to [MITRE ATLAS](/docs/compliance/atlas-mapping/) and [NIST SP 800-53](/docs/compliance/nist-800-53/).
- **Vulnerabilities are fixed and disclosed.** Reports are handled privately and published as [advisories](https://github.com/tech4242/aquaman/security/advisories) with the fix. Stay on the latest release.
- **Scope.** aquaman keeps credentials out of the agent. It is not a sandbox and does not separate programs running as you: [what it does not do](/docs/compare/#what-aquaman-does-not-do).

[Security policy and how to report](/docs/security/). Requires Node.js 18 or later on macOS, Linux or WSL2. Apache-2.0 licensed.
