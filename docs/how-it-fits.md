# How aquaman fits together

aquaman is one daemon that reads the vault you already have and hands a key off in one of three ways. Which way applies depends on what your agent host lets aquaman do. This page says what each way gives you, so you know what you get with your host.

<!-- diagram: overview -->

## The daemon

`aquaman-proxy` is the only part that touches your vault. It does four things:

- **Reads your vault.** Keychain, 1Password, Bitwarden, HashiCorp Vault, KeePassXC, Keeper, systemd-creds or an encrypted file. aquaman runs no vault service and needs no account; the encrypted file is for when you have no vault. An item that already exists in your vault can be [linked](https://aquaman.sh/docs/agent-setup/) instead of typed again.
- **Asks you.** When an agent requests a key, or wants to link an existing item, the daemon shows a dialog on your screen, and the agent's command only waits for the answer.
- **Hands out only what was set up.** A key is forwarded only for a service on the proxied list (Anthropic, OpenAI, Slack, Discord and GitHub unless you change it) and handed out only for a reference you declared. Everything else is refused before the vault is read.
- **Writes an audit entry for every use,** in a log on your machine chained by SHA-256. The log can be switched off (`audit.enabled: false`), and then nothing is recorded.

The other packages are adapters that connect one kind of host to the daemon.

## The three hand-offs

| | Forward and inject | Resolve | Hand to the host |
|---|---|---|---|
| What happens | aquaman adds the key to the outgoing request | one command, or a host at startup, gets the key in its environment | the host asks for the key and injects it at its own egress |
| Used by | [OpenClaw](https://aquaman.sh/docs/openclaw/) model providers and Telegram, [Hermes](https://aquaman.sh/docs/hermes/) (Anthropic and OpenAI keys), [your own app](https://aquaman.sh/docs/app-through-proxy/) | [Claude Code](https://aquaman.sh/docs/claude-code/) and [Codex](https://aquaman.sh/docs/codex/), Hermes project secrets | [NVIDIA OpenShell](https://aquaman.sh/docs/openshell/), [Docker Sandboxes](https://aquaman.sh/docs/docker-sandboxes/), [Agent Substrate](https://aquaman.sh/docs/agent-substrate/) |
| Who holds the key | aquaman only | that one process | the host, outside its sandbox |
| Your vault as the source | yes | yes | yes |
| Only what you set up for it | services on the proxied list | declared references | declared references, or grants for Agent Substrate |
| Audit entry (unless you switch the log off) | every request | every hand-out | every hand-out |
| Method and path rules | yes | no | no |

### Forward and inject

The agent or app sends its request to aquaman on your machine with a local token in place of the key. aquaman checks your [request policy](https://github.com/tech4242/aquaman#request-policies), adds the real key and sends the request on. The key never reaches the agent or the app, and this is the only hand-off where you can limit what a key is used for: which methods and which paths.

### Resolve

Some hosts leave no way to route a request, and many commands (`git`, `terraform`, a test runner) expect the key in their environment. For these, aquaman gives the value to that one process. With Claude Code and Codex, the command's output is redacted before it reaches the conversation. The process itself holds the key while it runs, so this guards against the key ending up in a transcript or a file, not against the command.

### Hand to the host

A sandbox host that injects credentials itself only needs a source for them. The host isolates the agent and adds the key on the way out; aquaman supplies the value from your vault, decides whether this host may have it, and records the hand-out. What the key is then used for is the host's to limit, not aquaman's.

## Which one you get

You do not choose a hand-off directly. Each host guide sets up the strongest one the host allows:

- Where a host lets a request be routed, the guide routes it, so the key stays in aquaman and your policy rules apply.
- Where it does not, the guide uses the next one and says so.
