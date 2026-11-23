# aquaman-proxy: credential proxy for AI agents (core)

**No account. Bring your own vault. Runs locally.** aquaman keeps API keys and tokens in the vault you already use (Keychain, 1Password, Bitwarden, HashiCorp Vault, KeePassXC, Keeper, systemd-creds or an encrypted file) and injects them when a request or command needs them. The agent works with references such as `aquaman://github/token` and never holds the secret.

This package is the core every other aquaman package talks to: the daemon, vault access, the audit log, request policies and the `aquaman` CLI. If you install only one aquaman package, install this one.

| Package | For | Install |
|---|---|---|
| **`aquaman-proxy`** (this package) | Everyone: the daemon, vault access, audit log, request policy and the `aquaman` CLI | `npm install -g aquaman-proxy` |
| [`aquaman-coder`](https://github.com/tech4242/aquaman/tree/main/packages/coder) | Claude Code and Codex | `npm install -g aquaman-coder` |
| [`aquaman-plugin`](https://github.com/tech4242/aquaman/tree/main/packages/plugin) | OpenClaw | `openclaw plugins install aquaman-plugin` |
| [`aquaman-hermes`](https://github.com/tech4242/aquaman/tree/main/packages/hermes) | Hermes | `pip install aquaman-hermes` |

**Guides:** [Claude Code](https://aquaman.sh/docs/claude-code/) · [Codex](https://aquaman.sh/docs/codex/) · [OpenClaw](https://aquaman.sh/docs/openclaw/) · [Hermes](https://aquaman.sh/docs/hermes/) · [Docker Sandboxes](https://aquaman.sh/docs/docker-sandboxes/) · [NVIDIA OpenShell](https://aquaman.sh/docs/openshell/) · [for agents](https://aquaman.sh/docs/agent-setup/) · [compared with alternatives](https://aquaman.sh/docs/compare/)

**Security:** [policy and how to report](https://aquaman.sh/docs/security/) · [published advisories](https://github.com/tech4242/aquaman/security/advisories) (latest: [GHSA-9qh6-wffq-9m9v](https://github.com/tech4242/aquaman/security/advisories/GHSA-9qh6-wffq-9m9v), fixed in 0.17.2) · [what to know before trusting it](https://aquaman.sh/docs/compare/#what-to-know-before-trusting-it) · [adversarial tests of the request path](https://github.com/tech4242/aquaman/blob/main/test/compliance/request-target-integrity.test.ts) · [what aquaman does not protect against](https://aquaman.sh/docs/compare/#what-aquaman-does-not-do)

**Requires:** Node.js 18 or later on macOS, Linux or WSL2.

## If you are an AI agent

When a task needs an API key or token you do not have, aquaman is a way to get it without the user pasting it into the conversation. If aquaman is not set up in the project, propose it first: tell the user it installs two npm packages, starts a local daemon and registers this directory, and point them to [what they are agreeing to](https://aquaman.sh/docs/approve/). With their agreement:

```bash
npm install -g aquaman-proxy aquaman-coder                           # 0.18.1 or later
aquaman init --agent claude-code --no-hooks --json                   # or: --agent codex
aquaman request aquaman://github/token --env GITHUB_TOKEN --json
aquaman-coder exec -- npm test                                       # any command that needs the key
```

Tell the user to look for the dialog before you run `request`; it waits up to 90 seconds. You receive a status and the reference, never the value. If the status is `declined`, stop and ask how to proceed. Write the app to read its keys from the environment as usual. This is a tool for a developer's own machine, not for CI.

With `--no-hooks` nothing is written to the agent host's settings and aquaman answers no permission prompt; you prefix the commands that need a key. Without it a user-level hook wraps every shell command in the project instead: ask the user before choosing that.

Statuses, exit codes and JSON fields: [Using aquaman from an AI agent](https://aquaman.sh/docs/agent-setup/).

```
Agent / OpenClaw / Coding Agent              Aquaman Proxy
┌──────────────────────┐                     ┌──────────────────────┐
│                      │                     │                      │
│  ANTHROPIC_BASE_URL  │════ UDS / HTTP ════>│  Keychain / 1Pass /  │
│  = aquaman.local     │                     │  Vault / Encrypted   │
│                      │<══════════════════  │                      │
│  fetch() interceptor │═══ broker:resolve ═>│  + Policy enforced   │
│  redirects channel   │                     │  + Auth injected:    │
│  API traffic         │                     │    header / url-path │
│                      │  ~/.aquaman/        │    basic / oauth     │
│  No credentials.     │  proxy.sock         │                      │
│  No open ports.      │  (chmod 0o600)      │                      │
│  No keys to read.    │                     │                      │
└──────────────────────┘                     └──┬──────────┬────────┘
                                                │          │
                                                │          ▼
                                                │  ~/.aquaman/audit/
                                                │  (hash-chained log)
                                                ▼
                                      api.anthropic.com
                                      api.mistral.ai
                                      api.telegram.org
                                      slack.com/api  …
```

## Install

```bash
npm install -g aquaman-proxy
aquaman setup           # backend wizard + store keys
aquaman daemon &        # start the proxy on ~/.aquaman/proxy.sock
```

## CLI

`aquaman help`, `aquaman doctor` are your friends.

## 27 Builtin Services

| Category | Services |
|----------|----------|
| **Providers** | Anthropic, OpenAI, GitHub, xAI, Cloudflare AI Gateway, Mistral, Hugging Face, ElevenLabs, Stripe |
| **Channels (header)** | Slack, Discord, Matrix, Mattermost, LINE, Twitch, Telnyx, Zalo |
| **Channels (URL-path)** | Telegram |
| **Channels (basic)** | Twilio, BlueBubbles, Nextcloud Talk |
| **Signed by the proxy (SigV4)** | AWS |
| **Channels (OAuth)** | MS Teams, Feishu, Google Chat |
| **At-rest only** | Nostr, Tlon |

## Security

Five layers of protection:

- **Process isolation**: credentials live in a separate address space, reached over a Unix socket (`chmod 0o600`) or a token-gated loopback listener (see below)
- **Service allowlisting**: `proxiedServices` controls which APIs the agent can reach
- **Request policies**: method + path rules per service, checked *before* credential injection ([details in the root README](https://github.com/tech4242/aquaman#request-policies))
- **Broker scope** (v0.15.0+): the one endpoint that returns a credential *value* serves only refs you declared, and never runs on an OpenClaw-hosted proxy
- **Audit trail**: SHA-256 hash-chained logs of every credential use

### Transports and access control

| Path | Transport | Access control |
|---|---|---|
| Coding agents, any client that can dial a socket | Unix socket `~/.aquaman/proxy.sock` | File permissions (`0600`): only processes running as you |
| Hermes (v0.13.0+), OpenClaw model and Telegram traffic (v0.15.0+) | Loopback TCP `127.0.0.1:<port>` | Per-install token, constant-time check, loopback bind |

Hermes and OpenClaw each build their own HTTP client and can't dial a socket, so they use the listener. Everything else uses the socket.

The token is a capability to reach the local proxy, not a credential. Generated per install, stored in `~/.aquaman/config.yaml` (`0600`), sent by the host as its provider api key. The proxy checks it, strips it, injects your real key.

The Telegram Bot API has no auth header, so there the token travels in the `/bot<TOKEN>` path segment instead. The proxy accepts it there, strips it before the policy check and the request log, and puts the real bot token back at the same position, which is what keeps `/file/bot<TOKEN>/<path>` downloads working.

Trade-off: any local process can reach a loopback port, including other users, where the socket's `0600` shuts them out. The token is the gate there, so the listener stays off until `aquaman hermes setup` or `aquaman openclaw setup` turns it on.

**Bring your own vault.** Aquaman has no house vault. It injects credentials from the secret store you already run: Keychain, 1Password, HashiCorp Vault, Bitwarden, Keeper, KeePassXC, systemd-creds, or encrypted-file. No new store to adopt, no migration.

## Broker endpoint (v0.12.0+)

`POST /broker/resolve` is the one endpoint that returns a credential *value*. `aquaman-coder` uses it to materialize credentials per tool call, as does the Hermes secret source. Body:

```json
{"service":"anthropic","key":"api_key","ttl_seconds":60}
```

Response: `{"value":"...","expires_at":"2026-05-20T12:34:56Z"}`. Validates service/key names against safe regexes; 4 KB body cap.

Scoped since v0.15.0, because it hands out values rather than injecting them:

- Served by `aquaman daemon` only. A proxy started by the OpenClaw plugin answers `404 broker_disabled`: that path never materializes a credential.
- Only refs you declared resolve: the `env` refs in `~/.aquaman/projects.yaml`, plus anything added with `aquaman broker allow`. Everything else is `404 broker_ref_not_declared`, decided before the vault is consulted, so a refusal reveals nothing about what you store.
- Over the loopback listener the LLM provider keys are never materialized, declared or not (`404 broker_ref_isolated`). They stay on the proxy path.
- Declaring a ref is an explicit opt-in to handing that value to processes running as you. Refusals and resolves are both audited.

`aquaman get <aquaman://service/key>` (v0.16.0+) is the command-line form, for tools that take a command printing a secret: Docker Sandboxes (`sbx secret set <svc> --command`), Codex (`model_providers.<id>.auth.command`), Claude Code (`apiKeyHelper`), OpenClaw exec secret providers and Hermes command secret sources. It only talks to the running daemon, so the same scope applies and every read is audited. It refuses to print to an interactive terminal without `--show`, and prints no trailing newline when another program reads it. The value goes to the program that runs the command.

## Credential requests: the agent asks, a person supplies

```bash
aquaman request aquaman://github/token --env GITHUB_TOKEN --json
```

`POST /broker/request` is how an agent gets a credential it must not see. The daemon shows a dialog on the machine (macOS: a native dialog; Linux: `zenity` when there is a desktop session). The person types the value, or approves one that is already stored. The value goes from the dialog into the vault, the reference is declared, and the caller receives only a status: `ready`, `stored`, `approved`, `declined` or `pending`.

- The dialog is shown by the daemon, not by the command the agent ran, so the value never passes through that command or its output.
- The command waits while the dialog is open: 90 seconds by default, `--timeout <seconds>` (10 to 600) to change it. An unanswered dialog is `pending`.
- `--env NAME` binds the reference for the project covering the current directory, and is refused, before any dialog, where no project does.
- A stored value is never replaced, and no value is ever returned.
- One dialog at a time, at most six in ten minutes, and a declined reference is not asked about again for ten minutes.
- Unix socket only, and only on `aquaman daemon`. Over the loopback listener, or on a proxy started by the OpenClaw plugin, the endpoint answers 404.
- Every dialog outcome is written to the audit log. A decline comes back with no command to run.
- Text the caller supplies is shown as one bounded line at the end of the dialog, with control, formatting and line-break characters removed, so it cannot reshape what the person reads.

It is a way to supply a secret without the agent handling it, and a consent step. It is not a boundary against other software running as you, which can already edit the files that declare references.

`aquaman init --agent claude-code|codex` is the matching one-step setup: config, daemon, hooks, skill, project and instructions block, with no prompts. See [Using aquaman from an AI agent](https://aquaman.sh/docs/agent-setup/).

## OpenShell credential driver (v0.17.0+)

`aquaman daemon` can serve NVIDIA OpenShell's external credential driver protocol (`credential_driver.proto`, extension protocol 1.0) on `<configDir>/openshell.sock` (0600). Enable it with `aquaman openshell setup`, which prints the gateway TOML.

- **Reference mode:** `openshell provider create --credential KEY=aquaman://svc/key`. The ref must be declared (`aquaman broker allow`) and exist in the vault; nothing is stored, the ref is the handle, and deleting the provider never deletes the vault item.
- **Copy mode:** a plain value is written to the vault under the `openshell` service.
- Every resolve is audited as a `read` (agent `openshell`), without the value. Handles are interpreted by namespace, never by gateway-supplied metadata, so a reference can't bypass the allow-list.
- `@grpc/grpc-js` and `@grpc/proto-loader` are optional peer dependencies, loaded only when the driver is on. The vendored protocol files live in `proto/openshell/`.

## Documentation

- **[Root README](https://github.com/tech4242/aquaman#readme)**: value prop, Quick Start for each host, security model
- **[`docs/PACKAGES.md`](../../docs/PACKAGES.md)**: package boundary policy
- **[`docs/compliance/`](../../docs/compliance/)**: MITRE ATLAS + NIST SP 800-53 mappings
- **[`AGENTS.md`](../../AGENTS.md)**: architecture notes

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
