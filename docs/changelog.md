# Changelog

What changed in each release of aquaman, newest first. The same notes are on [GitHub Releases](https://github.com/tech4242/aquaman/releases). All four packages (`aquaman-proxy`, `aquaman-coder`, `aquaman-plugin` on npm and `aquaman-hermes` on PyPI) share one version number.

To update:

```bash
npm install -g aquaman-proxy aquaman-coder
openclaw plugins install clawhub:aquaman-plugin   # OpenClaw users
pip install -U aquaman-hermes                     # Hermes users
```

## 0.18.2

Setup no longer writes secrets to `config.yaml` or shows them as you type.

### Fixes that affect your secrets

#### `aquaman setup` could write your vault password into `config.yaml`

Running `aquaman setup` on a machine that already had a config saved values that are meant to exist only in the environment: `AQUAMAN_ENCRYPTION_PASSWORD`, and in the same way `VAULT_TOKEN`, the loopback token and the other environment overrides. `aquaman hermes setup` did the same for everything except the password.

**Check now if you use the `encrypted-file` or Vault backend:** open `~/.aquaman/config.yaml`. If it has an `encryptionPassword` or `vaultToken` line, delete the line and consider changing that password or token. The file is `0600`, so it was readable by your user only, but the password is what protects the vault file next to it.

Setup commands now write what is in the file plus what they decide themselves, and nothing from the environment.

#### Secret prompts showed what you typed

The API key prompts of `aquaman setup` and `aquaman openclaw setup`, and the KeePassXC master-password prompt, echoed every key to the terminal. If you typed a key or a master password there during a screen share or a terminal recording, treat it as seen and rotate it. The prompts now show nothing, as `aquaman credentials add` already did.

#### `aquaman hermes setup` left an existing `~/.hermes/.env` readable by others

The loopback token was written into an existing `.env` without tightening its permissions. The file is now set to `0600`, as a newly created one always was. Run `aquaman hermes setup` again, or `chmod 600 ~/.hermes/.env`.

#### The credential dialog said the agent never receives the value

The dialog that `aquaman request` opens said "The agent receives a reference, never the value". For an ordinary request that stopped being true once you agreed: the reference is then declared, and aquaman hands the value to the commands the agent runs in the project, and to any other program running as you that asks for it. The dialog now says so. For a request made with `--via-proxy`, where the reference is not declared, it says what happens there instead: the app gets a local token and aquaman adds the key on the way out.

Only the wording changed, not what is stored or handed out. The page a person reads before agreeing to aquaman ([approve](https://aquaman.sh/docs/approve/)) said the agent "cannot read the value from aquaman"; it now says that the project's commands are given the value and the conversation is not.

#### A credential could be handed out without an audit entry

If the audit log could not be written (a full disk, a directory that had become read-only), `aquaman get` and `aquaman-coder exec` still received the value with no record of the read, and the daemon then exited. A value is now handed out only after its audit entry is written. When the write fails, the read is refused with an error and a fix (`audit_unavailable`), the OpenShell driver refuses its resolve the same way, a request forwarded through the proxy is answered with a 500 in place of the upstream's response, and the daemon keeps running and prints `AUDIT FAILURE` to its output. A forwarded request has already been sent upstream by the time its entry is written, so on that path it is the response that is withheld, not the request.

### Other fixes

- **Re-running `aquaman openclaw setup` no longer resets `config.yaml`.** It used to rebuild the file from defaults: a new loopback token (so the one in `openclaw.json` and `~/.hermes/.env` stopped working), the default port, and no declared broker references, request policies or custom proxied services. It now keeps all of that and changes only the backend, policy presets for newly stored services that have none, and the loopback listener. A first run is unchanged.
- **HashiCorp Vault backend:** a 500 or 403 response whose body contained the text "404" was reported as "credential not stored" by get, delete and list. It is now reported as the error it is.
- **`aquaman openclaw migrate --auto --cleanup`** no longer prints "Replaced ... with placeholder" and exits 0 when `openclaw.json` could not be written. It says the plaintext is still there and exits 1. The credential is in the vault either way.
- **`aquaman init --agent --loopback`** checks whether it can restart the proxy before it changes anything. A run that stops with an error leaves `config.yaml` as it was.
- **OpenClaw plugin status** shows the sentinel URL for GitHub and for services with a hyphen in the name, instead of "(not set)". Display only; routing was not affected.
- **OpenClaw plugin:** stopping the proxy returns when the proxy had failed to start, instead of waiting forever.
- **Hermes plugin:** `aquaman_hermes.__version__` reports the package version (it said 0.13.0).
- **Request policy: a deny rule could be passed by respelling the request.** A method-override header that carried a list (`X-HTTP-Method-Override: DELETE, GET`) or was sent twice was read as one unknown method; a deny rule for `/v1/admin/**` did not match `/v1/Admin/users`; and `X-Original-URL`, `X-Rewrite-URL` and a `?_method=` parameter were not looked at. Each matters only against an upstream that honours that spelling. Policy now counts every entry of a list as a method, matches deny rules without regard to case (allow rules stay exact), and evaluates the method or path those headers and that parameter name. Your policy config needs no change.
- **`encrypted-file` vault:** a vault file whose GCM authentication tag had been cut down, to as little as 32 bits, was accepted. Only the full 128-bit tag is accepted now. Files aquaman wrote are unaffected.
- **Loopback listener:** a `Host` header such as `[::1]evil.example` passed the check that the request names this machine. The whole header is checked now.
- **`/broker/resolve`** answers 400, not 500, to a JSON body that is not an object.
- **`daemon.pid`** is created `0600`. It was `0644`, inside a `0700` directory.

### Removed exports

The certificate and signing helpers are no longer exported from `aquaman-proxy`: `generateSelfSignedCert`, `generateSigningKeyPair`, `sign`, `verify`, `generateNonce`, and the types `SigningKeyPair` and `SelfSignedCert`. Nothing in aquaman used them; the proxy has listened on a Unix socket without TLS since 0.7.0. If you imported them, use `node:crypto` directly.

### Tests

Coverage is now measured over everything that ships, including both CLIs, the plugin entry point and the code that only runs in the processes the tests start (the CLI, the daemon, the hook). Measured that way, line coverage went from 67.3% to about 99%, and CI enforces a floor of 95% overall and per package. The setup, backend and plugin fixes above came out of that work. Every fix in this release has a test that fails without it.

Before release, this version was assessed against OWASP ASVS 5.0, the OWASP Top 10 for Agentic Applications and for LLM Applications, the OWASP API Security Top 10, NIST SP 800-53, NIST SSDF and BSI TR-02102-1. The dialog, audit and policy fixes above came out of that. The compliance tests now try to break each control, one table row per attack: tampering with the audit log, getting past a deny rule, the vault's cryptographic parameters, the dialog's wording against what a caller can then obtain, and output redaction.

Where the code does not stop an attack, the test row is marked as a known limit and the mapping states it. One of them changes an earlier claim: `aquaman audit verify` detects an entry that was altered, inserted or deleted inside the log, and does not detect a log cut short at the end, emptied, deleted or rebuilt, because nothing outside the file anchors the chain. The others are two output shapes that redaction misses, four spellings a deny rule does not cover, and PBKDF2 where BSI TR-02102-1 recommends Argon2id.

The [NIST SP 800-53 mapping](https://aquaman.sh/docs/compliance/nist-800-53/) states what an audit entry records and what the chain detects, the [agentic AI page](https://aquaman.sh/docs/compliance/agentic-ai-guidance/) links each OWASP claim to its test, and there is a new [BSI TR-02102-1 mapping](https://aquaman.sh/docs/compliance/bsi-tr-02102/).

### Breaking changes

The removed exports above, if you imported them. Nothing else changes: no config format, endpoint, hook or manifest change, and no action needed beyond the checks under "Fixes that affect your secrets". Two behaviours are stricter: a credential read is refused while the audit log cannot be written, and a request policy's deny rules match more spellings of the same request.

## 0.18.1

Agents set aquaman up and request credentials themselves, the app an agent builds can be kept from holding the key, and the licence is Apache-2.0.

> **0.18.1 is the first complete release of this line.** `aquaman-proxy@0.18.0` reached npm on its own before its release was stopped, without the plugin and coder packages and without the HashiCorp Vault fix below. Install 0.18.1.

### Agents can set aquaman up and ask for credentials themselves

```bash
npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app
aquaman init --agent claude-code --no-hooks      # or: --agent codex
aquaman request aquaman://github/token --env GITHUB_TOKEN
aquaman-coder exec -- npm test
```

- **`aquaman init --agent`** creates the config if there is none, starts the daemon, registers the directory as a project, installs an `aquaman-credentials` skill and adds a short block to `CLAUDE.md` or `AGENTS.md`. It never prompts and is safe to run again. Anything only a person can do comes back in `human_steps`.
- **`--no-hooks`** installs no hook and changes no setting of Claude Code or Codex. The agent runs the commands that need a key as `aquaman-coder exec -- <command>`. This is the form the docs recommend. Without the flag a user-level hook wraps every shell command in registered projects, as before.
- **`aquaman request`** makes the daemon show a dialog on your machine. You type the value, or approve one that is already stored. It goes from the dialog into your vault; the agent gets a status and the reference, never the value. `--timeout` sets how long the dialog waits (default 90 seconds).
- `--json` on `init`, `request`, `coder bind`, `coder doctor` and `coder status`.

The contract for agents (JSON fields, statuses, exit codes, what `init` changes and how to undo it) is in [docs/agent-setup.md](https://aquaman.sh/docs/agent-setup/). What a person is agreeing to when an agent proposes aquaman is in [docs/approve.md](https://aquaman.sh/docs/approve/).

### Keep the key out of your app too

```bash
aquaman init --agent claude-code --no-hooks --loopback
aquaman request aquaman://openai/api_key --env OPENAI_API_KEY --via-proxy OPENAI_BASE_URL
aquaman-coder exec -- npm start
```

With `--via-proxy` the app is started with a local token and aquaman's address in place of the key. aquaman adds the real key on the way out, and your request policies apply to what the app sends. It works for any app that reads its API base URL from the environment, for HTTP APIs that take a header credential. Stripe is now a built-in service (26 in total), and any other API is a few lines in `services.yaml`. Guide: [docs/app-through-proxy.md](https://aquaman.sh/docs/app-through-proxy/).

The token only forwards requests to routed services on your machine. It cannot be used to read a credential, and a key bound only this way is not handed to anything, `aquaman get` included.

### Licence

aquaman is licensed under **Apache-2.0** from this release. Versions up to 0.17.2 remain MIT. The Bitwarden and systemd-creds backends were contributed under MIT and stay offered under it; see `NOTICE`.

### Behaviour changes to expect

- **`aquaman-coder exec --raw` needs a terminal on stdout.** Piping or capturing its output no longer works; drop `--raw` and the output is redacted.
- The hook wraps a command, and answers `allow` for it, only when at least one of the project's references has a credential in the vault.
- `aquaman-coder exec` does not run a command when none of the project's credentials can be resolved, and leaves a single missing one unset with a warning.
- New hook installs call `aquaman-coder hook` directly. Existing installs keep working.
- The loopback listener refuses requests addressed by a name other than `127.0.0.1` or `localhost`, and refuses to start on a non-loopback address.
- A binding cannot name a variable that controls how programs are loaded (`PATH`, `LD_*`, `NODE_OPTIONS` and similar).
- CLI banners show an octopus and say "credential proxy".

### Fixes

- **Encrypted-file vault:** a credential added while the daemon is running is picked up without a restart.
- **A stopped daemon no longer blocks the command that starts it.**
- Daemon-down messages name the same fix everywhere, and that fix never installs a hook nobody asked for.
- The loopback listener accepts `Authorization: token ...` as well as `Bearer`, which is what GitHub's Node client sends.
- **HashiCorp Vault backend:** listing one service's keys checks the service name like every other path does, and listing everything skips entries under the prefix that aquaman did not write.

### New daemon endpoints (Unix socket, `aquaman daemon` only)

- `POST /broker/request`: never returns or replaces a value; one dialog at a time, six per ten minutes, no repeat for ten minutes after a decline.
- `POST /broker/available`: whether a resolve would return a value, as booleans.
- `POST /broker/route`: the local address and forwarding token for a routed reference. Never a credential.

None is served by a proxy the OpenClaw plugin starts.

### Website and docs

The docs now live at **[aquaman.sh](https://aquaman.sh)**: one guide per host, the [contract for agents](https://aquaman.sh/docs/agent-setup/), and a [comparison with other tools](https://aquaman.sh/docs/compare/) that says when to pick something else. Every page is also served as Markdown (same address with `.md`), with an index at [aquaman.sh/llms.txt](https://aquaman.sh/llms.txt).

- `llms.txt` and the agent guide say which mechanism applies per host and whether the key is in the process, and when an agent should not propose aquaman.
- The OpenClaw, Hermes, Docker Sandboxes and OpenShell guides each have a section for agents.
- The npm and PyPI packages link to the site as their homepage.

### Breaking changes

`aquaman-coder exec --raw` without a terminal now exits with an error. Nothing else.

## Earlier releases

| Version | Date | What it was |
|---|---|---|
| [0.17.2](https://github.com/tech4242/aquaman/releases/tag/v0.17.2) | 2026-11-15 | Security release, [GHSA-9qh6-wffq-9m9v](https://github.com/tech4242/aquaman/security/advisories/GHSA-9qh6-wffq-9m9v): a crafted request path could send a stored credential to another host. Update from anything older. |
| [0.17.1](https://github.com/tech4242/aquaman/releases/tag/v0.17.1) | 2026-11-14 | Claude Code permission rules apply to wrapped commands again; dependency advisories cleared. |
| [0.17.0](https://github.com/tech4242/aquaman/releases/tag/v0.17.0) | 2026-10-14 | NVIDIA OpenShell credential driver. |
| [0.16.0](https://github.com/tech4242/aquaman/releases/tag/v0.16.0) | 2026-09-25 | `aquaman get`, Codex support, Keeper backend, Docker Sandboxes path. |
| [0.15.0](https://github.com/tech4242/aquaman/releases/tag/v0.15.0) | 2026-09-20 | The credential broker serves declared references only; OpenClaw model and Telegram traffic routed through the proxy. |

Older versions are listed on [GitHub Releases](https://github.com/tech4242/aquaman/releases).
