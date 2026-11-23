# Using aquaman from an AI agent

aquaman is a credential proxy for AI agents: secrets stay in the user's own vault and are injected when a command or request needs them. This page is the contract for an agent (Claude Code, Codex or similar) that wants to use it. Every command here runs without prompting and can print JSON.

Requires Node.js 18 or later on macOS, Linux or WSL2, and aquaman 0.18.1 or later: `aquaman init --agent` and `aquaman request` do not exist before that. Check with `aquaman --version`.

**Where this fits.** Write the app to read its keys from the environment (`process.env.GITHUB_TOKEN`, `os.environ["GITHUB_TOKEN"]`) as you would anyway. aquaman is how those variables get set on the user's machine while you work, without the value passing through you or a `.env` file. It is not a replacement for the environment, and in CI and production the same variable names are filled by that platform's own secrets: see [CI and production](#ci-and-production).

## When to propose it, and when not

Propose aquaman when a task needs a secret you do not have and the alternative is asking the user to paste it or writing it into a `.env` file. If the secret is already an item in the user's password manager or vault, a reference can point at that item (`--from`, [below](#an-item-that-is-already-in-the-vault)), so nothing is typed or copied.

Do not propose aquaman when the host's own CLI is already signed in and can do the task (`gh`, `wrangler login`, a cloud CLI), when the user has said how secrets are handled in the project, when the work runs in CI or on a server, when no secret is involved, or when the user has 1Password and only needs environment variables for local commands (`op run` does that).

Which mechanism applies, and where the key ends up:

- **OpenClaw gateway:** the plugin routes model calls and Telegram through the proxy, so those keys are never in the gateway process. Tokens for other channels are stored in the vault and used by the gateway directly.
- **Hermes:** provider keys go through the proxy and are never in the Hermes process. Project secrets bound through the secret source do enter Hermes' environment.
- **An app or agent you build that calls HTTP APIs:** with `--via-proxy` it holds a local token and aquaman's address, never the key, and request policies apply. This needs an API that takes the credential in a header or as HTTP basic auth, and a client that accepts a base URL.
- **Any other command run by Claude Code or Codex:** the key is set in that one command's environment and its output is redacted. That is the same kind of protection as `op run`.
- **Docker Sandboxes and NVIDIA OpenShell:** they do the isolating. aquaman supplies the value from the vault by reference, with an allow-list and an audit entry.

This page covers Claude Code and Codex. For the other hosts the setup is the person's: see the "If you are an agent" section of the [OpenClaw](openclaw.md), [Hermes](hermes.md), [Docker Sandboxes](docker-sandboxes.md) and [NVIDIA OpenShell](openshell.md) guides.

If aquaman is not installed or the project is not set up, ask before you install or run anything. Tell the user it installs two npm packages, starts a local daemon and registers this directory, and give them [what they are agreeing to](approve.md). If it is already set up (`aquaman coder status --json` shows this directory as a project), go straight to step 2.

## 1. Set up the project

```bash
npm install -g aquaman-proxy aquaman-coder    # if `aquaman` is not installed
cd <the project directory>
aquaman init --agent claude-code --no-hooks --json       # or: --agent codex
```

The packages are `aquaman-proxy` and `aquaman-coder`; the command they install is `aquaman`. The npm package named `aquaman` is an unrelated project: do not install it or run `npx aquaman`.

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
| `service` | With `--service`: the answer to the login-item request. `status` is `installed`, `already_installed`, `declined`, `pending` or `error`, with `unit` (the file), and `reason`, `error` and `fix` where they apply. `ok` does not depend on it |
| `mode` | `exec` or `hook`: how commands in this project get their variables (see above) |
| `run` | With `mode: exec`, the prefix to use: `aquaman-coder exec -- <command>` |
| `hooks` | The host's settings file, whether aquaman's hook is `installed` in it, and whether this run `changed` it |
| `skill`, `agents_file` | The file each was written to, and whether it changed |
| `human_steps` | Things only a person can do as a result of this run, such as restarting the session or trusting the hooks in Codex. Pass them on. Empty when a repeat run changed nothing. Without `--service`, while nothing starts the daemon at login, it holds one entry naming `aquaman service install` (not with the `encrypted-file` backend, which that command refuses) |
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
| `linked` | 0 | `--from` named an item that already exists in the vault; the user allowed it and it could be read | Continue |
| `declined` | 2 | The user said no. No `fix` is returned | Do not ask again and do not work around it; ask how to proceed |
| `pending` | 3 | Nobody answered, or nobody could be asked (no desktop session) | Ask once more if the user is there; otherwise show them the `fix` command and wait |
| `error` | 4 | The daemon is not running or does not take requests, or it refused the request: `code` says which | Run step 1, then retry. For a `link_` code, read [the codes](#an-item-that-is-already-in-the-vault) |
| `error` | 1 | The command was wrong: bad reference, bad `--env`, `--timeout` or `--from`, or `--env` used outside a project | Read `error` and `fix` |

With `--env NAME` the reference is bound to that variable for the project covering the current directory, so commands run there through `aquaman-coder exec`, or through the hook in hook mode, have the variable set. Run it from the project directory. Where no project covers the directory the command stops with exit 1 before any dialog is shown; it never creates a project.

Output fields:

| Field | Present | Meaning |
|---|---|---|
| `status` | Always | One of the values above |
| `ref` | Always | The reference you asked for |
| `env` | With `--env`, on `ready`, `stored`, `approved` or `linked` | The variable now bound to the reference in this project |
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
{ "status": "error", "ref": "aquaman://github/token", "error": "Cannot reach the aquaman proxy at /Users/you/.aquaman/proxy.sock", "code": "proxy_unreachable", "fix": "Start the daemon in the background: aquaman init --agent <agent> --no-hooks   (in a terminal of your own: aquaman daemon)" }
```

```json
{ "status": "error", "ref": "aquaman://github/token", "error": "The vault is locked, so nothing can be stored or approved yet", "code": "vault_locked", "fix": "Run: aquaman unlock" }
```

The wording of `reason`, `error` and `fix` can change between versions; branch on `status` and the exit code.

`vault_locked` (exit code 4, and no dialog is shown) comes from a daemon on the Bitwarden backend that has no session yet, or whose session Bitwarden has ended. The fix is the user's: `aquaman unlock` needs a terminal and their master password, so do not run it yourself. Tell the user to run it in a terminal of their own, then repeat your command. `aquaman get`, `aquaman-coder exec` and the proxy itself answer with the same code and fix while the vault is locked, and `aquaman init --agent` lists the step under `human_steps` and reports `"vault": "locked"`.

One reference per call. For several keys, run the command once for each; the dialogs appear one after another.

The daemon shows one dialog at a time and at most six in ten minutes, and does not ask again about a declined reference for ten minutes.

### An item that is already in the vault

When the user already keeps the secret in their password manager, they do not have to type it again. A link makes aquaman read a reference from that item:

```bash
aquaman request aquaman://github/token --from 'op://Private/GitHub/token' --env GITHUB_TOKEN --json
```

Use `--from` only with a locator the user gave you. Do not guess item names: the dialog shows the user exactly what you wrote, and a wrong guess is a dialog they have to refuse.

The dialog is an approval; nothing is typed. It names the reference and the item, and says what happens if the user agrees. aquaman does not read the item, or check whether it exists, until the user has agreed. Then it reads it once. If that works it records the approval and the link and answers `linked`; if not it records nothing and answers with a `code`.

The approval is kept in the vault, as one item of aquaman's own (`aquaman_internal/link_approvals`) that names each approved reference and its locator. It is hidden from `aquaman credentials list` and cannot be read, declared, linked or changed through aquaman. A link is read only when that record holds exactly the same reference and locator. A link written into `config.yaml` by hand has no approval and reads nothing: a command that uses it fails with a message that names `aquaman credentials link`, and you do not get the value.

One locator form per vault backend. A locator only works with the backend that is configured:

| Backend | Locator |
|---|---|
| 1Password | `op://<vault>/<item>/[<section>/]<field>` |
| Bitwarden | `bw://<item id or exact item name>/<field>`, where the field is `password`, `username`, `notes` or the name of a custom field |
| HashiCorp Vault | `vault://<mount>/<path>#<field>` (KV v2) |
| macOS Keychain, libsecret | `keychain://<service>/<account>` (a generic password) |
| KeePassXC | `keepassxc://<Group/.../Entry title>#<field>`; the field defaults to `Password` |
| Keeper | `keeper://<record UID>/<field>`; the field defaults to `password` |
| encrypted file, systemd-creds | None. These hold only what aquaman wrote |

A locator is at most 200 characters, has no control characters and no backslash, and no part of it starts with `-` or is `.` or `..`. A `/` inside a name is written `%2F` (not in `op://` or `keeper://` locators, which take no escapes; address such a 1Password item by its ID). No other character may be percent-encoded, except `#`, `?` and `%` themselves: the person approves the locator as it is written, so it has to read as what it names. A locator that goes to the dialog is printable ASCII only, from `--from` and from `aquaman credentials link` alike; an item whose name has other characters is linked by its ID.

**aquaman only reads a linked item.** It never writes to it or deletes it. `aquaman credentials add` and `delete` on a linked reference are refused; `aquaman credentials unlink <ref>` removes the link and leaves the item as it was. A link never replaces a value aquaman stored, and a typed value is never stored over a link.

`--from` works with `--env`, `--via-proxy`, `--base-path`, `--timeout` and `--json` as in any other request. With `--via-proxy` the reference is linked and not declared, so the value is still not handed to commands.

**`aquaman credentials link <ref> <locator>` links without declaring.** It sends the daemon the same request with `declare: false`, and the user approves it in the same kind of dialog, which says that the value is added to requests aquaman forwards for the service and is not given to commands unless the reference is also declared (`aquaman broker allow <ref>`). It does not need a terminal, and a terminal is not taken as proof of a person. `aquaman request --from` is the form for a credential your commands need: it links and declares in one approval.

| `aquaman credentials link` | Exit |
|---|---|
| Linked, or already linked to this item and approved | 0 |
| The user chose "Deny", or declined this reference in the last ten minutes | 2 |
| Nobody answered the dialog, another dialog was open, or too many were shown | 3 |
| The daemon refused (a `code` from the table below), the locator or reference is wrong, or the daemon is not running | 1 |

Only where the daemon reports that it cannot show a dialog at all (a machine with no desktop session) does `aquaman credentials link` ask in the terminal instead: it says what the link does and waits for the word `yes`, then reads the item and records the approval and the link itself. Without a terminal in that case it exits 1. That path is for the user at their own terminal, not for you.

| `code` | Exit | When | Meaning |
|---|---|---|---|
| `link_invalid_locator` | 1 | Before any dialog | The locator does not parse. `fix` shows the form for the configured backend |
| `link_backend_mismatch` | 1 | Before any dialog | The locator's scheme belongs to another backend |
| `link_unsupported_backend` | 1 | Before any dialog | The configured backend holds only what aquaman wrote |
| `link_exists` | 4 | Before any dialog | The reference is already linked to a different item. The user removes that link first |
| `link_unreadable` | 4 | After the user agreed | Nothing could be read at the locator, or the vault failed, or the approval could not be written to the vault. Nothing was recorded. Ask the user for the correct locator. A request without `--from` gets the same code, with no dialog, for a reference whose link is in `config.yaml` and reads nothing (the item is gone, or nobody approved the link) |
| `link_value_stored` | 4 | After the user agreed | aquaman already stores a value under this reference. Nothing was recorded. Request it without `--from`, or the user deletes the stored value first |

```json
{ "status": "linked", "ref": "aquaman://github/token", "env": "GITHUB_TOKEN" }
```

```json
{ "status": "error", "ref": "aquaman://github/token", "error": "Nothing could be read at op://Private/GitHub/token", "code": "link_unreadable", "fix": "Check the item and field names in your vault, then ask again with the corrected locator" }
```

A `pending` answer carries the command for the user: `aquaman credentials link <service>/<key> '<locator>'`, followed by `aquaman broker allow` when the request would have declared the reference. It is for the user to run, not you: it opens a dialog of its own, so running it yourself only asks the user a second time. When the daemon could not show a dialog at all, the answer also carries `"code": "prompt_unavailable"`. `aquaman credentials list` shows a linked reference with its locator, and `aquaman doctor` reports a link whose scheme does not fit the configured backend.

Links are kept in `credentials.links` in `~/.aquaman/config.yaml`, as `<service>/<key>: <locator>`, and each one counts only together with its approval in the vault. A running daemon picks up a new link and its approval; nothing needs restarting. `aquaman credentials unlink <ref>` removes the link and its approval, so putting the same line back into the file does not bring the reading back.

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

It stops with exit 1 before any dialog when the route cannot work: `--loopback` was not given to `init`, the proxy has no definition for the service, the service takes its credential neither in a header nor as HTTP basic auth, or the reference is not a key the proxy injects for it. `error` and `fix` say which. Services, `services.yaml` and limits: [Keep an API key out of the app a coding agent builds](app-through-proxy.md).

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

`init` starts the daemon in the background. Unless a login item is installed, it is gone after a reboot or logout.

To have it start at every login, add `--service`:

```bash
aquaman init --agent claude-code --no-hooks --service --json
```

After setup has succeeded, the daemon shows the user an approval dialog that says aquaman will start at every login and how to remove it. You get the answer as `service.status`: `installed` or `already_installed` when it is in place, `declined` when the user said no (stop and ask; there is no `fix`), `pending` when nobody could be asked (give the user the `fix`: run `aquaman service install` in a terminal), `error` when it was refused, with the reason. `aquaman service install --json` is the same request as a command of its own, with exit codes 0, 2, 3, 4 and 1. Propose this only when the user wants the daemon to survive a reboot; do not add `--service` unprompted. What is installed, and its limits: [Start the aquaman daemon at login](autostart.md).

While it is down, `aquaman-coder exec` stops before running the command and names the fix. In hook mode, in a project that has bindings, the hook refuses shell commands instead of running them without their credentials. The refusal names the fix. aquaman's own commands (`aquaman ...`, `aquaman-coder ...`) are never refused, so:

```bash
aquaman init --agent claude-code --no-hooks --json    # starts the daemon again; changes nothing else, and leaves a hook that is already installed in place
```

Do not run `aquaman daemon` yourself: it stays in the foreground and your command will not return.

## What init changes

| Where | What | Scope |
|---|---|---|
| `~/.aquaman/` | `config.yaml` if missing, `projects.yaml`, the audit log, the daemon's socket and log | This user |
| A background process | `aquaman daemon`, started if not already running | Until logout or reboot |
| A launchd agent (`~/Library/LaunchAgents/sh.aquaman.daemon.plist`) or a systemd user unit (`~/.config/systemd/user/aquaman.service`) | **Only with `--service`, and only after the user allowed it in a dialog.** Starts the daemon at every login | This user. Removed with `aquaman service uninstall` |
| `~/.aquaman/config.yaml` and a listener on `127.0.0.1` | **Only with `--loopback`.** Turns on the token-gated loopback listener and generates its token | This user. Any local process can connect to the port; only one with the token is answered |
| `~/.claude/settings.json` or `~/.codex/hooks.json` | **Not with `--no-hooks`.** A `PreToolUse` and a `PostToolUse` hook. On macOS with Claude Code, also one sandbox allowlist entry for the aquaman socket | **User level: the hook runs in every project**, and does nothing outside directories registered with aquaman, apart from redacting secret-shaped strings in tool output |
| `~/.claude/skills/aquaman-credentials/` or `~/.agents/skills/aquaman-credentials/` | The skill that tells an agent to use `aquaman request` | User level |
| `CLAUDE.md` or `AGENTS.md` in the project | A short block between `<!-- aquaman:start -->` and `<!-- aquaman:end -->` | The project. `--no-instructions` skips it |

What the user should know before agreeing:

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
- A link is read only with an approval recorded in the vault, so software that can only edit `~/.aquaman/config.yaml` cannot make aquaman read an item. Software that can write to the vault itself, through the vault's own CLI or API, can write the approval record too.
- On a machine where no dialog can be shown, the word `yes` typed at a terminal is the only check on `aquaman credentials link`, and a program can give itself a terminal.
- A daemon that caches values (1Password, Bitwarden, HashiCorp Vault and Keeper, 15 minutes by default) can serve a value it already read for up to that long if a link is removed and written back by hand before the reference is next used. The item itself is not read again.
- A locator in plain ASCII can still carry words meant to persuade. The dialog shows it on a line of its own, marked as the caller's text, below aquaman's wording.
- A linked item is read with whatever access the configured vault session has. The link names one field of one item, and aquaman reads only that.
- Link reads were tested against stand-ins for `op`, `bw`, Keeper Commander, HashiCorp Vault and the keychain library, and against a generated KeePassXC database, not against live accounts.
- Commands started with Claude Code's Monitor tool are not wrapped.
- This is a tool for one person's machine. It has no team sharing and does not run in CI or production: see [CI and production](#ci-and-production).
- The project is young and has one maintainer: [what to know before trusting it](compare.md#what-to-know-before-trusting-it).
