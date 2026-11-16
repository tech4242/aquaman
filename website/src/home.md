aquaman is an open-source tool that runs on your machine. When Claude Code or Codex needs a key, it asks aquaman; you type the value into a system dialog, it is stored in the vault you already use, and it is set for the commands that need it. The value does not pass through the agent, the transcript or a `.env` file. No account. Your app still reads its keys from the environment.

It does the same job for agent hosts: OpenClaw, Hermes, Docker Sandboxes and NVIDIA OpenShell get their keys from your vault through a local proxy, and hold a placeholder.

## Start

**Run it yourself**

```bash
npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app && aquaman init --agent claude-code --no-hooks      # or: --agent codex
```

**Or hand it to your agent.** Paste this into Claude Code or Codex:

```text
Set up aquaman in this project so you can request credentials instead of me pasting them.
Read https://github.com/tech4242/aquaman/blob/main/docs/agent-setup.md first and tell me
what it will change before you run anything.
```

Using OpenClaw, Hermes, Docker Sandboxes or OpenShell instead? Go to [your host](#pick-your-host).

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
- **Keeps evidence.** Every credential use goes into a log on your machine, chained by SHA-256, so tampering is detectable with `aquaman audit verify`.

## Pick your host

One vault and one daemon serve all of them. How the credential arrives differs by host, and the difference matters.

| Host | How the credential is injected | Install | Guide |
|---|---|---|---|
| Claude Code | Into each command, output redacted | `aquaman-proxy`, `aquaman-coder` | [Keep API keys out of Claude Code](/docs/claude-code/) |
| Codex | Into each command, output redacted | `aquaman-proxy`, `aquaman-coder` | [Give Codex a token without a .env file](/docs/codex/) |
| OpenClaw | At egress, by the proxy | `aquaman-plugin` | [Keep API keys out of the OpenClaw gateway process](/docs/openclaw/) |
| Hermes | At egress, by the proxy | `aquaman-proxy`, `aquaman-hermes` | [Keep provider keys out of the Hermes agent process](/docs/hermes/) |
| Docker Sandboxes | At egress, by Docker; aquaman supplies the value | `aquaman-proxy` | [Docker Sandboxes secrets from your own vault](/docs/docker-sandboxes/) |
| NVIDIA OpenShell | At egress, by OpenShell; aquaman supplies the value | `aquaman-proxy` | [Use your own vault as the OpenShell credential driver](/docs/openshell/) |

aquaman is for your own machine. In CI and production the same variable names are filled from that platform's secrets, and for some setups another tool fits better: [how it compares](/docs/compare/).

## Security

- **Runs entirely on your machine.** No account, no telemetry, no hosted service. Config and logs are plain files under `~/.aquaman`.
- **Open source, verifiable releases.** MIT licensed. npm packages are published from GitHub Actions with provenance, and have no install scripts.
- **Every credential use is recorded** in a hash-chained log that `aquaman audit verify` checks.
- **Tested against attack, not just for function.** The request path has a conformance suite that sends raw bytes at a real proxy, and the controls are mapped to [MITRE ATLAS](/docs/compliance/atlas-mapping/) and [NIST SP 800-53](/docs/compliance/nist-800-53/).
- **Vulnerabilities are fixed and disclosed.** Reports are handled privately and published as [advisories](https://github.com/tech4242/aquaman/security/advisories) with the fix. Stay on the latest release.
- **Scope.** aquaman keeps credentials out of the agent. It is not a sandbox and does not separate programs running as you: [what it does not do](/docs/compare/#what-aquaman-does-not-do).

[Security policy and how to report](/docs/security/). Requires Node.js 18 or later on macOS, Linux or WSL2. MIT licensed.
