# Using aquaman from an AI agent

aquaman is a credential proxy for AI agents: secrets stay in the user's own vault and are injected when a command or request needs them. This page is the contract for an agent (Claude Code, Codex or similar) that wants to use it. Every command here runs without prompting and can print JSON.

Requires Node.js 18 or later on macOS, Linux or WSL2.

## 1. Set up the project

```bash
npm install -g aquaman-proxy aquaman-coder    # if `aquaman` is not installed
cd <the project directory>
aquaman init --agent claude-code --json       # or: --agent codex
```

`init` never asks for a secret and is safe to run again. It refuses to register the home directory, or a directory that contains it, as a project. Tell the user what it is about to change before you run it: the list is under [What init changes](#what-init-changes).

Output fields:

| Field | Meaning |
|---|---|
| `ok` | `true` when everything is in place |
| `config` | `path`, `created`, and the vault `backend` in use |
| `daemon` | `running`, `started` (by this run), `socket`, and `log` when it was started |
| `project` | `name`, `path`, `created` |
| `hooks`, `skill`, `agents_file` | The file each was written to, and whether it changed |
| `human_steps` | Things only a person can do as a result of this run, such as restarting the session or trusting the hooks in Codex. Pass them on. Empty when a repeat run changed nothing |
| `next` | The command to ask for a credential |
| `error`, `fix` | Present when `ok` is `false` |

Exit code 0 on success, 1 on failure.

## 2. Ask for a credential

```bash
aquaman request aquaman://github/token --env GITHUB_TOKEN --json
```

The daemon shows a dialog on the user's machine. They type the value, or approve one that is already in the vault. The value goes from the dialog into the vault. The command prints a status and the reference, never the value.

**The command waits while the dialog is open: 90 seconds by default.** Tell the user to look for the dialog before you run it. `--timeout <seconds>` (10 to 600) changes the wait; only raise it if whatever runs your commands allows one to take that long. An unanswered dialog is `pending`, and asking once more is fine.

| `status` | Exit | Meaning | What to do |
|---|---|---|---|
| `ready` | 0 | Already stored and usable; nobody was asked | Continue |
| `stored` | 0 | The user typed it; it is in the vault now | Continue |
| `approved` | 0 | It was in the vault; the user allowed its use | Continue |
| `declined` | 2 | The user said no. No `fix` is returned | Do not ask again and do not work around it; ask how to proceed |
| `pending` | 3 | Nobody answered, or nobody could be asked (no desktop session) | Ask once more if the user is there; otherwise show them the `fix` command and wait |
| `error` | 4 | The daemon is not running or does not take requests | Run step 1, then retry |
| `error` | 1 | The command was wrong: bad reference, bad `--env` or `--timeout`, or `--env` used outside a project | Read `error` and `fix` |

With `--env NAME` the reference is bound to that variable for the project covering the current directory, so every shell command run there has the variable set. Run it from the project directory. Where no project covers the directory the command stops with exit 1 before any dialog is shown; it never creates a project.

The daemon shows one dialog at a time and at most six in ten minutes, and does not ask again about a declined reference for ten minutes.

## 3. Use it

Run commands as usual. The hook wraps each shell command so the project's variables are present for that command only. In output a value appears as `[REDACTED:injected-value]`: that means it is set. Do not try to print or decode it.

Outside an agent session, or in a script: `aquaman-coder exec -- <command>`.

A variable whose credential is not in the vault yet is left unset as long as another one in the project is available, with a line on stderr such as `aquaman: STRIPE_SECRET_KEY is not set for this command: ...`. The command still runs, and other variables are unaffected. Once the credential is added, by `aquaman request` or by the user with `aquaman credentials add`, the next command has it; nothing needs restarting.

**What this protects.** The command you run, and the app it starts, receive the real value in their environment. You, the transcript and the repository do not. This is the same kind of protection as `op run` or `doppler run`, with the value coming from the user's own vault and each read logged. aquaman's request policies apply to traffic sent through its proxy, not to these commands. If the app must not hold the key either, its HTTP client has to be pointed at the proxy; see the [README](../README.md#1-use-the-proxy-on-its-own).

## 4. Check and diagnose

```bash
aquaman coder status --json    # { current_project, projects: [{ name, paths, env }], hooks, broker: { reachable, socket } }
aquaman coder doctor --json    # { ok, issues, checks: [{ name, ok, detail, fix }] }, exit 1 if any check fails
```

`env` maps hold references, never values. `broker.reachable` is whether the daemon is up.

## When the daemon is not running

`init` starts the daemon in the background. It is not installed as a system service, so it is gone after a reboot or logout.

While it is down, in a project that has bindings, the hook refuses shell commands instead of running them without their credentials. The refusal names the fix. aquaman's own commands (`aquaman ...`, `aquaman-coder ...`) are never refused, so:

```bash
aquaman init --agent claude-code --json    # starts the daemon again; changes nothing else
```

Do not run `aquaman daemon` yourself: it stays in the foreground and your command will not return.

## What init changes

| Where | What | Scope |
|---|---|---|
| `~/.aquaman/` | `config.yaml` if missing, `projects.yaml`, the audit log, the daemon's socket and log | This user |
| A background process | `aquaman daemon`, started if not already running | Until logout or reboot |
| `~/.claude/settings.json` or `~/.codex/hooks.json` | A `PreToolUse` and a `PostToolUse` hook. On macOS with Claude Code, also one sandbox allowlist entry for the aquaman socket | **User level: the hook runs in every project**, and does nothing outside directories registered with aquaman, apart from redacting secret-shaped strings in tool output |
| `~/.claude/skills/aquaman-credentials/` or `~/.agents/skills/aquaman-credentials/` | The skill that tells an agent to use `aquaman request` | User level |
| `CLAUDE.md` or `AGENTS.md` in the project | A short block between `<!-- aquaman:start -->` and `<!-- aquaman:end -->` | The project. `--no-instructions` skips it |

Two things the user should know before agreeing:

- **Permission prompts change in the project (Claude Code).** Once the project has a binding with a credential behind it, the hook answers `allow` for each shell command it wraps. A project whose bindings all point at nothing is left alone: commands run unwrapped, with the usual prompts. The user's `deny` and `ask` rules still apply to the original command, but a command that no rule matches runs without a prompt. A user who relies on being asked should add `ask` rules.
- **Codex needs its sandbox opened to reach the daemon.** `init` does not do this; it returns it in `human_steps`. On Codex 0.169 the setting that allows it also gives sandboxed commands outbound network access.

**Vault backend.** A new config gets the macOS Keychain on macOS; on Linux the keyring if libsecret is present, otherwise systemd-creds, otherwise an encrypted file. The encrypted file needs a password from a person: `AQUAMAN_ENCRYPTION_PASSWORD`, 12 characters or more, set where the daemon starts. `init` stops with that instruction in `fix` and `human_steps`. Do not make up a password: the user needs it to open the vault later. To use 1Password, Bitwarden, HashiCorp Vault, KeePassXC or Keeper, the user runs `aquaman setup` first.

**Undo.**

```bash
aquaman coder setup claude-code --uninstall    # or: codex. Removes the hooks
aquaman coder project remove <name>            # forgets the project and its bindings
aquaman stop                                   # stops the daemon
```

Then delete the skill directory and the marked block. Stored credentials stay in the vault until removed with `aquaman credentials delete <service> <key>`.

## Rules

- Never ask the user to paste a secret into the conversation, and never write one into a file, a command line or a commit.
- Do not create `.env` files that hold secrets.
- References look like `aquaman://<service>/<key>`: lowercase service, then a key name such as `token`, `api_key` or `secret_key`. Any service name works for a binding; it does not have to be one the proxy has a definition for.

## Limits worth knowing

- The wrapped command receives the real value, so a command can misuse it. Redaction catches accidental exposure, not a command that deliberately transforms the value.
- `aquaman request` is a convenience and a consent step, not a boundary against other software running as the same user.
- Commands started with Claude Code's Monitor tool are not wrapped.
- This is a tool for one person's machine. It has no team sharing and is not meant for CI or production; use the team's secrets manager there.
- The project is young and has one maintainer: [what to know before trusting it](compare.md#what-to-know-before-trusting-it).
