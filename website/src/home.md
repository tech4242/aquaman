aquaman is an open-source credential proxy for AI agents. No account, bring your own vault, runs locally. API keys stay in the vault you already use and are injected when a request or command needs them.

```bash
npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app && aquaman init --agent claude-code      # or: --agent codex
```

Your app does not change: it reads its keys from the environment as it would anyway. aquaman is how those variables get set on your machine while the agent works, without the value passing through the agent, the transcript or a `.env` file.

Guides: [Claude Code](/claude-code/), [Codex](/codex/), [OpenClaw](/openclaw/), [Hermes](/hermes/), [Docker Sandboxes](/docker-sandboxes/), [NVIDIA OpenShell](/openshell/). Or [compare it with the alternatives](/compare/).

## If you are an AI agent

When a task needs an API key or token, do not ask the user to paste it. Set the project up once, then ask for the credential by reference. A person supplies the value in a dialog; you get a status and the reference, never the value. Neither command prompts in the terminal; `request` waits up to 90 seconds for the person to answer the dialog.

```bash
npm install -g aquaman-proxy aquaman-coder                           # if `aquaman` is not installed; needs 0.18.0 or later
aquaman init --agent claude-code --json                              # or: --agent codex
aquaman request aquaman://github/token --env GITHUB_TOKEN --json
```

What `request` prints when the person has typed the value:

```json
{ "status": "stored", "ref": "aquaman://github/token", "env": "GITHUB_TOKEN" }
```

Write the app to read `process.env.GITHUB_TOKEN` as usual. Statuses, exit codes, JSON fields, what `init` changes and how to undo it: [Using aquaman from an AI agent](/agent-setup/).

Every page on this site is also served as Markdown at the same path with `.md`. The index is [/llms.txt](/llms.txt) and the whole site in one file is [/llms-full.txt](/llms-full.txt).

## What it does

- **Keeps the key out of the agent.** Keys live in a separate proxy process that injects them into outgoing requests, or into one command at a time for coding agents. The agent holds a reference or a placeholder.
- **Limits what a key can do, for traffic through the proxy.** Per-service request policies decide which endpoints may be called, and a denied request never gets a credential. A coding agent's commands receive the key in their environment instead, so policies do not apply to them.
- **Keeps evidence.** Every credential use goes into a log on your machine, chained by SHA-256, so tampering is detectable with `aquaman audit verify`.

## Pick your host

One vault and one daemon serve all of them. How the credential arrives differs by host, and the difference matters.

| Host | How the credential is injected | Install | Guide |
|---|---|---|---|
| Claude Code | Into each command, output redacted | `aquaman-proxy`, `aquaman-coder` | [Keep API keys out of Claude Code](/claude-code/) |
| Codex | Into each command, output redacted | `aquaman-proxy`, `aquaman-coder` | [Give Codex a token without a .env file](/codex/) |
| OpenClaw | At egress, by the proxy | `aquaman-plugin` | [Keep API keys out of the OpenClaw gateway process](/openclaw/) |
| Hermes | At egress, by the proxy | `aquaman-proxy`, `aquaman-hermes` | [Keep provider keys out of the Hermes agent process](/hermes/) |
| Docker Sandboxes | At egress, by Docker; aquaman supplies the value | `aquaman-proxy` | [Docker Sandboxes secrets from your own vault](/docker-sandboxes/) |
| NVIDIA OpenShell | At egress, by OpenShell; aquaman supplies the value | `aquaman-proxy` | [Use your own vault as the OpenShell credential driver](/openshell/) |

## CI and production

aquaman runs on one person's machine and is not used in CI or production. The app does not need it there: because the code only reads environment variables, the same names are filled from that platform's own secret store.

## When to pick something else

- You already pay for 1Password and only need environment variables for local commands: `op run` does that.
- The program itself must never hold the key, for any API: fnox `proxy run` injects at egress for any HTTPS host you write a rule for.
- You only use Claude Code with its sandbox on: its credential masking is built in.
- Your team already runs Doppler or Infisical: secrets shared across a team, CI and production belong there.

[The full comparison](/compare/), including what aquaman does not do.

## What to know before trusting it

- One maintainer, no third-party audit. Started in February 2026, still 0.x.
- It has had a serious bug: [GHSA-9qh6-wffq-9m9v](https://github.com/tech4242/aquaman/security/advisories/GHSA-9qh6-wffq-9m9v) (high), fixed in 0.17.2 and disclosed. Use 0.17.2 or later.
- It is not a boundary against other software running as you, and it is not a sandbox.
- npm packages are published from GitHub Actions with provenance. No install scripts.
- No account, no telemetry, no network service of its own. Config and logs are plain files under `~/.aquaman`.

[Security policy and how to report](/security/). Requires Node.js 18 or later on macOS, Linux or WSL2. MIT licensed.
