# Using aquaman from an AI agent

aquaman is a credential proxy for AI agents: secrets stay in the user's own vault and are injected when a command or request needs them. This page is the contract for an agent (Claude Code, Codex or similar) that wants to use it. Every command here runs without prompting and can print JSON.

Requires Node.js 18 or later on macOS, Linux or WSL2, and aquaman 0.18.0 or later: `aquaman init --agent` and `aquaman request` do not exist before that. Check with `aquaman --version`.

**Where this fits.** Write the app to read its keys from the environment (`process.env.GITHUB_TOKEN`, `os.environ["GITHUB_TOKEN"]`) as you would anyway. aquaman is how those variables get set on the user's machine while you work, without the value passing through you or a `.env` file. It is not a replacement for the environment, and in CI and production the same variable names are filled by that platform's own secrets: see [CI and production](#ci-and-production).

## 1. Set up the project

```bash
npm install -g aquaman-proxy aquaman-coder    # if `aquaman` is not installed
cd <the project directory>
aquaman init --agent claude-code --no-hooks --json       # or: --agent codex
```

There are two forms, and which one you run decides how commands get their credentials later:

| Form | What it installs in the agent host | How a command gets the variables | `mode` in the output |
|---|---|---|---|
| `--no-hooks` | Nothing. No setting of Claude Code or Codex is changed, and aquaman answers no permission prompt | You run it as `aquaman-coder exec -- <command>` | `exec` |
| without it | A user-level hook that wraps every shell command in registered projects, and answers the permission prompt for the commands it wraps | Automatically, after the session is restarted | `hook` |

Use `--no-hooks` unless the user has asked for the hook: it is the form that changes nothing outside aquaman's own files, the skill and the project. Propose the hook when they want commands to work without a prefix. If hooks are already installed from an earlier run, `--no-hooks` leaves them in place and reports `mode: hook`.

`init` never asks for a secret and is safe to run again. It refuses to register the home directory, or a directory that contains it, as a project. Tell the user what it is about to change before you run it: the list is under [What init changes](#what-init-changes).

Output fields:

| Field | Meaning |
|---|---|
| `ok` | `true` when everything is in place |
| `config` | `path`, `created`, and the vault `backend` in use |
| `daemon` | `running`, `started` (by this run), `socket`, and `log` when it was started |
| `project` | `name`, `path`, `created` |
| `loopback` | With `--loopback`: `enabled`, the listener's `url`, whether this run `changed` the config, and `daemon_restarted` when it had to |
| `mode` | `exec` or `hook`: how commands in this project get their variables (see above) |
| `run` | With `mode: exec`, the prefix to use: `aquaman-coder exec -- <command>` |
| `hooks` | The host's settings file, whether aquaman's hook is `installed` in it, and whether this run `changed` it |
| `skill`, `agents_file` | The file each was written to, and whether it changed |
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

Output fields:

| Field | Present | Meaning |
|---|---|---|
| `status` | Always | One of the values above |
| `ref` | Always | The reference you asked for |
| `env` | With `--env`, on `ready`, `stored` or `approved` | The variable now bound to the reference in this project |
| `reason` | On `declined` and `pending` | Why, in words |
| `fix` | On `pending`, and on `error` | A command that gets past the problem. For `pending` it is one for the user to run in their own terminal. Never present on `declined` |
| `error`, `code` | On `error` | What went wrong, and the daemon's machine-readable code when it has one |
| `via_proxy` | With `--via-proxy`, on success | `url_env` and `base_path`: the variable that holds the proxy URL |
| `env_error` | When the credential is usable but the binding failed | Why; `fix` then holds the `aquaman coder bind` command |

```json
{ "status": "stored", "ref": "aquaman://github/token", "env": "GITHUB_TOKEN" }
```

```json
{ "status": "pending", "ref": "aquaman://github/token", "reason": "nobody answered the dialog", "fix": "aquaman credentials add github token && aquaman broker allow aquaman://github/token && aquaman coder bind GITHUB_TOKEN=aquaman://github/token" }
```

```json
{ "status": "error", "ref": "aquaman://github/token", "error": "Cannot reach the aquaman proxy at /Users/you/.aquaman/proxy.sock", "code": "proxy_unreachable", "fix": "Start the daemon in the background: aquaman init --agent <agent>   (in a terminal of your own: aquaman daemon)" }
```

The wording of `reason`, `error` and `fix` can change between versions; branch on `status` and the exit code.

One reference per call. For several keys, run the command once for each; the dialogs appear one after another.

The daemon shows one dialog at a time and at most six in ten minutes, and does not ask again about a declined reference for ten minutes.

## 3. Use it

**With `mode: exec`**, run a command that needs a credential as `aquaman-coder exec -- <command>`, for example `aquaman-coder exec -- npm test`. It sets the project's variables for that command only and redacts them in its output. A command you run without the prefix does not have them. 

The prefix is for giving a command its credentials, not a way around the user's permission rules. Those rules are matched against the text of the command, so one written for `git push` does not match `aquaman-coder exec -- git push`. If a command would be refused or need approval without the prefix, do not run it with the prefix: ask. A user who adds an allow rule for `aquaman-coder exec` allows every command run that way, and should keep their `deny` rules in the prefixed form too. `--raw`, which turns redaction off, only works with a terminal on stdout, so it does nothing for a command whose output you capture.

**With `mode: hook`**, the hooks are not loaded in the session that installed them. `init` says so in `human_steps` (Claude Code: restart or start a new session; Codex: trust the hooks at startup). Until the user has done that, use `aquaman-coder exec -- <command>` as above. Once the hooks are loaded, run commands as usual: the hook wraps each shell command so the project's variables are present for that command only. In output a value appears as `[REDACTED:injected-value]`: that means it is set. Do not try to print or decode it.

Outside an agent session, or in a script: `aquaman-coder exec -- <command>`. That is also how the user starts the app themselves, for example `aquaman-coder exec -- npm start`.

A variable whose credential is not in the vault yet is left unset as long as another one in the project is available, with a line on stderr such as `aquaman: STRIPE_SECRET_KEY is not set for this command: ...`. The command still runs, and other variables are unaffected. Once the credential is added, by `aquaman request` or by the user with `aquaman credentials add`, the next command has it; nothing needs restarting.

**What this protects.** The command you run, and the app it starts, receive the real value in their environment. You, the transcript and the repository do not. This is the same kind of protection as `op run` or `doppler run`, with the value coming from the user's own vault and each read logged. aquaman's request policies apply to traffic sent through its proxy, not to these commands. If the app must not hold the key either, bind it with `--via-proxy` (next section).

## Keeping the key out of the app too

```bash
aquaman init --agent claude-code --no-hooks --loopback --json
aquaman request aquaman://stripe/secret_key --env STRIPE_SECRET_KEY --via-proxy STRIPE_API_BASE --json
```

With `--via-proxy <URL_ENV>` the command gets a local token in the `--env` variable and the proxy's URL for the service in `URL_ENV`, instead of the key. Write the app to read its base URL from that variable, falling back to the vendor's address, and to send the "key" it was given as usual. The proxy swaps the token for the real key and applies the user's request policies. That token only forwards requests to routed services; it cannot be used to fetch a value, and while a reference is bound this way aquaman hands its value to nothing. The reply carries `"via_proxy": { "url_env": ..., "base_path": ... }`.

It stops with exit 1 before any dialog when the route cannot work: `--loopback` was not given to `init`, the proxy has no definition for the service, or the reference is not the key the proxy injects for it. `error` and `fix` say which. Services, `services.yaml` and limits: [Keep an API key out of the app a coding agent builds](app-through-proxy.md).

Prefer this when the client library accepts a base URL (OpenAI and Anthropic SDKs read one from the environment; Octokit and Stripe take one as an option). Tell the user that `--loopback` opens a token-gated listener on `127.0.0.1`.

## Example: a service that needs three keys

```bash
aquaman init --agent claude-code --no-hooks --json
aquaman request aquaman://github/token --env GITHUB_TOKEN --json
aquaman request aquaman://openai/api_key --env OPENAI_API_KEY --json
aquaman request aquaman://stripe/secret_key --env STRIPE_SECRET_KEY --json
aquaman-coder exec -- npm test
```

The code reads `process.env.GITHUB_TOKEN`, `process.env.OPENAI_API_KEY` and `process.env.STRIPE_SECRET_KEY` and knows nothing about aquaman. Commit a `.env.example` that lists the three names with empty values, so the next person and the deployment know what to supply.

## CI and production

aquaman runs on one person's machine. It is not used in CI or production, and the app does not need it there: because the code only reads environment variables, the same names are set from the platform's own secret store (GitHub Actions secrets, the host's environment settings, the team's secrets manager). Tell the user which variable names to add there; `aquaman coder status --json` lists them for the project under `env`. Do not copy values out of aquaman to do it.

## 4. Check and diagnose

```bash
aquaman coder status --json    # { current_project, projects: [{ name, paths, env }], hooks, broker: { reachable, socket } }
aquaman coder doctor --json    # { ok, issues, checks: [{ name, ok, detail, fix }] }, exit 1 if any check fails
```

`env` maps hold references, never values. `broker.reachable` is whether the daemon is up.

## When the daemon is not running

`init` starts the daemon in the background. It is not installed as a system service, so it is gone after a reboot or logout.

While it is down, `aquaman-coder exec` stops before running the command and names the fix. In hook mode, in a project that has bindings, the hook refuses shell commands instead of running them without their credentials. The refusal names the fix. aquaman's own commands (`aquaman ...`, `aquaman-coder ...`) are never refused, so:

```bash
aquaman init --agent claude-code --json    # starts the daemon again; changes nothing else
```

Do not run `aquaman daemon` yourself: it stays in the foreground and your command will not return.

## What init changes

| Where | What | Scope |
|---|---|---|
| `~/.aquaman/` | `config.yaml` if missing, `projects.yaml`, the audit log, the daemon's socket and log | This user |
| A background process | `aquaman daemon`, started if not already running | Until logout or reboot |
| `~/.aquaman/config.yaml` and a listener on `127.0.0.1` | **Only with `--loopback`.** Turns on the token-gated loopback listener and generates its token | This user. Any local process can connect to the port; only one with the token is answered |
| `~/.claude/settings.json` or `~/.codex/hooks.json` | **Not with `--no-hooks`.** A `PreToolUse` and a `PostToolUse` hook. On macOS with Claude Code, also one sandbox allowlist entry for the aquaman socket | **User level: the hook runs in every project**, and does nothing outside directories registered with aquaman, apart from redacting secret-shaped strings in tool output |
| `~/.claude/skills/aquaman-credentials/` or `~/.agents/skills/aquaman-credentials/` | The skill that tells an agent to use `aquaman request` | User level |
| `CLAUDE.md` or `AGENTS.md` in the project | A short block between `<!-- aquaman:start -->` and `<!-- aquaman:end -->` | The project. `--no-instructions` skips it |

Two things the user should know before agreeing:

- **Permission prompts change in the project (Claude Code, hook mode only).** Once the project has a binding with a credential behind it, the hook answers `allow` for each shell command it wraps. A project whose bindings all point at nothing is left alone: commands run unwrapped, with the usual prompts. The user's `deny` and `ask` rules still apply to the original command, but a command that no rule matches runs without a prompt. A user who relies on being asked should add `ask` rules.
- **Without the hook, output of other tools is not scrubbed.** `aquaman-coder exec` redacts the output of the command it runs. The hook additionally redacts secret-shaped strings in every tool's output on Claude Code; `--no-hooks` gives that up.
- **A sandboxed command must be able to reach the daemon's socket.** On macOS the hook setup allowlists it for Claude Code's sandbox; with `--no-hooks` the user does that themselves (`aquaman coder doctor` says how) or runs without the sandbox.
- **Codex needs its sandbox opened to reach the daemon.** `init` does not do this; it returns it in `human_steps`. On Codex 0.169 the setting that allows it also gives sandboxed commands outbound network access.

**Vault backend.** A new config gets the macOS Keychain on macOS; on Linux the keyring if libsecret is present, otherwise systemd-creds, otherwise an encrypted file. The encrypted file needs a password from a person: `AQUAMAN_ENCRYPTION_PASSWORD`, 12 characters or more, set where the daemon starts. `init` stops with that instruction in `fix` and `human_steps`. Do not make up a password: the user needs it to open the vault later. To use 1Password, Bitwarden, HashiCorp Vault, KeePassXC or Keeper, the user runs `aquaman setup` first, in their own terminal: it asks questions.

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
- This is a tool for one person's machine. It has no team sharing and does not run in CI or production: see [CI and production](#ci-and-production).
- The project is young and has one maintainer: [what to know before trusting it](compare.md#what-to-know-before-trusting-it).
