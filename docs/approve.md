# Your agent asked to use aquaman

Your coding agent needs an API key or token for the task you gave it. Instead of asking you to paste the key into the conversation, it is proposing aquaman: a small open-source tool that runs on your machine, keeps the key in the vault you already use, and sets it for the commands that need it. The agent works with a reference such as `aquaman://github/token` and never receives the value.

This page is what you are agreeing to.

## What gets installed and changed

If you say yes, the agent runs two things:

```bash
npm install -g aquaman-proxy aquaman-coder
aquaman init --agent claude-code --no-hooks        # or: --agent codex
```

| Where | What |
|---|---|
| Global npm packages | `aquaman-proxy` and `aquaman-coder`. Published from GitHub Actions with provenance; no install scripts |
| `~/.aquaman/` | A config file, the list of projects, an audit log, and the daemon's socket and log |
| A background process | `aquaman daemon`, running as you until you log out or reboot |
| `~/.claude/skills/aquaman-credentials/` (Claude Code) or `~/.agents/skills/aquaman-credentials/` (Codex) | A short instruction file that tells the agent to use aquaman when it needs a credential |
| `CLAUDE.md` or `AGENTS.md` in this project | A short marked block saying the project uses aquaman |

Nothing is written to your agent's settings and no permission prompt changes. There is no account and no telemetry, and nothing is sent anywhere except the API calls your own commands make.

## What you will see

When the agent asks for a key, a system dialog titled "aquaman" opens on your screen. It names the credential, for example `github/token`, and says where the request came from. You type the value and choose "Store in vault", or you choose "Cancel".

- The value goes from the dialog into your vault: the macOS Keychain by default on a Mac, or 1Password, Bitwarden, HashiCorp Vault, KeePassXC, Keeper, systemd-creds or an encrypted file.
- The agent is told `stored` and gets the reference. If you cancel, it is told `declined` and is instructed not to ask again or work around it.
- aquaman never asks for your login, Apple ID or password-manager password. A dialog that does is not this one.

After that the agent runs commands that need the key as `aquaman-coder exec -- <command>`. The command gets the key in its environment for as long as it runs, and where the key would appear in its output the agent sees `[REDACTED:injected-value]`.

## What the agent can and cannot do afterwards

- It can run commands in this project that use the key. Those commands hold the real value while they run, the same as with a `.env` file.
- It cannot read the value from aquaman, and it is not in the conversation, the transcript or any file in your repository.
- Every use is written to a log on your machine: `aquaman audit tail`.

aquaman keeps the key out of the agent. It is not a sandbox and does not separate programs running as you. The full statement of its limits is in [what aquaman does not do](compare.md#what-aquaman-does-not-do).

## Two things the agent may ask for later

- **A hook, so commands need no prefix.** `aquaman init` without `--no-hooks` installs a user-level hook in your agent's settings that wraps every shell command in registered projects and answers the permission prompt for the commands it wraps. It is more convenient and changes more; say yes only if you want that.
- **Keeping the key out of your app as well.** With `--loopback` and `--via-proxy` the app talks to a local proxy and holds a local token instead of the key. This opens a listener on `127.0.0.1` that only answers requests carrying aquaman's own tokens. See [Keep an API key out of the app a coding agent builds](app-through-proxy.md).

## Undo

```bash
aquaman coder project remove <name>            # forget the project and its bindings
aquaman stop                                   # stop the daemon
aquaman credentials delete <service> <key>     # remove a stored credential
npm uninstall -g aquaman-proxy aquaman-coder
```

Then delete the skill directory, the marked block in `CLAUDE.md` or `AGENTS.md`, and `~/.aquaman`.

Details of every command and field: [Using aquaman from an AI agent](agent-setup.md).
