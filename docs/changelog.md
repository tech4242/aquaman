# Changelog

What changed in each release of aquaman, newest first. The same notes are on [GitHub Releases](https://github.com/tech4242/aquaman/releases). All four packages (`aquaman-proxy`, `aquaman-coder`, `aquaman-plugin` on npm and `aquaman-hermes` on PyPI) share one version number.

To update:

```bash
npm install -g aquaman-proxy aquaman-coder
openclaw plugins install clawhub:aquaman-plugin   # OpenClaw users
pip install -U aquaman-hermes                     # Hermes users
```

## 0.21.0

Four things that kept aquaman from being the answer in cases people asked about: a stdio MCP server can now run under `aquaman-coder exec`, a credential can be marked so that a person is asked before its value is handed out, the Bitwarden backend works with the login item, and the proxy signs AWS requests.

### A stdio MCP server under `aquaman-coder exec`

- `aquaman-coder exec -- node ./mcp/server.js` works as the `command` of a stdio server in `.mcp.json`. Each reply reaches the host when the server writes it; before, the end of a reply was held back until the next one.
- A reply that contains an injected value reaches the host with `[REDACTED:injected-value]` in its place.
- **Fixed: output redaction of a value that arrives in two pieces.** When the output of a command was split inside an injected value and the first piece already looked like a key of a known format (the first half of an Anthropic, OpenAI, Slack or GitLab key does), that piece was replaced and the rest of the value was written as it was. The part held back between pieces is now kept as it arrived and redacted together with what follows. The tests cut values of five formats at every position and at every pair of positions.
- A token bound with `--via-proxy` gives the server a local token and the proxy's address in place of the key, so the key is never in the server's process.
- `exec` passes SIGTERM, SIGINT and SIGHUP on to the command, so a server stops when its host stops the wrapper.
- What was run, in Claude Code 2.1.330 with a stand-in server and a stand-in API: the server connected, the tool that calls the API was answered with the real key added by the proxy, the tool that returns its own token came back redacted, and no server was left running after the session. Guide: [Credentials for MCP servers](https://aquaman.sh/docs/mcp/).

### Ask first: a dialog before a credential is handed out

A declared reference is handed to any program running as you that asks the daemon for it. A reference can now be marked "ask first": the daemon shows its dialog the first time the value is requested and remembers a yes for a while. Nothing changes for references that are not marked.

- **Marking:** `aquaman broker ask <ref>`, `aquaman broker allow <ref> --ask`, or `aquaman request <ref> --ask`. Marking asks nobody.
- **The first read waits for you.** `aquaman get`, `aquaman-coder exec`, `POST /broker/resolve` and the OpenShell driver's Resolve all go through the same check, before the vault is read. The dialog says that aquaman cannot tell which program is asking, and that a yes lets any program running as you read that value until the window ends.
- **The loopback listener never raises a dialog.** A request there for a marked reference nobody has allowed is answered `ask_first_required`, with the command to run on the machine to be asked (`aquaman get <ref> > /dev/null`).
- **The window** is 8 hours, or `broker.askFirstWindowSeconds` in `config.yaml` (60 to 86400). A yes covers one reference and is gone when the daemon stops or its vault is locked (`aquaman lock`). While the vault is locked nobody is asked: the answer is `vault_locked`.
- **The mark is in your vault**, not in `config.yaml` or `projects.yaml`, so editing those files does not remove it. A record that cannot be read marks every reference. The record holds 256 references.
- **One item, two names.** On the `1password` and `systemd-creds` backends two references can name the same item. The mark, a yes and a no hold for the item under either name, and the tier that is never handed out over the loopback listener does too.
- **Removing a mark** (`aquaman broker ask <ref> --off`) is decided in the daemon's dialog. No flag or environment variable answers it. If the record cannot be read, the dialog lists the references that stay marked.
- **A reference revoked while its dialog is up** is not handed out on a yes.
- **Refusals** are `404` with a `code`: `ask_first_declined`, `ask_first_unanswered`, `prompt_unavailable`. `aquaman get` exits 2 when you declined and 3 when nobody answered or no dialog could be shown. `aquaman-coder exec` leaves that one variable unset, says why on stderr, and does not run a command for which nothing was handed out.
- **Hermes:** the secret source never raises the dialog. A marked reference nobody has allowed is a warning that names the command to run (`aquaman get <ref> > /dev/null`).
- **Forwarding:** a request forwarded for a service defined in `services.yaml` goes through the same check, because that file decides where the credential is sent; the dialog shows the address, and a refusal is `403` with the same `code`. Requests forwarded for a builtin service are not gated, and references bound with `--via-proxy` are never handed out.
- Every dialog outcome is an entry in the audit log.
- Limits: a yes is for the reference, not for a program; software that can write to the vault itself can delete the mark; a program can fill the record, since marking asks nobody; with no daemon serving the broker, two commands that write the record at the same moment can lose one mark; where no dialog can be shown, a typed `yes` at a terminal is the only check on removing a mark. The agent contract has the details: [ask first](https://aquaman.sh/docs/agent-setup/#ask-first-a-dialog-before-a-value-is-handed-out).
- The dialog was exercised with a scripted stand-in for the person; the tests check its exact wording and what the daemon does after each answer.

### AWS through the proxy

- A new built-in service, `aws`, and a new auth mode in which the proxy signs each request with AWS Signature Version 4. `aquaman-coder bind AWS_ACCESS_KEY_ID=aquaman://aws/access_key_id --via-proxy AWS_ENDPOINT_URL` gives a command a local token as its access key id, a fixed placeholder as its secret access key and the proxy as its AWS endpoint. The access key id, secret access key and optional session token stay in the vault. Guide: [Call AWS without giving the app your AWS keys](https://aquaman.sh/docs/aws/).
- The proxy builds the AWS host itself, always under `amazonaws.com`, from the region and service the client signed for. `/aws/_host/<prefix>` reaches an endpoint whose name is not its signing name and `/aws/_global` a service with one endpoint for all regions; `exec` sets `AWS_ENDPOINT_URL_IAM` and `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` to those forms.
- Refused with an error, a code and a fix, and never forwarded half-signed: bodies sent as signed chunks, presigned URLs, SigV4A, and bodies over 16 MiB other than S3 uploads with an unsigned payload.
- Request policy applies to the method and the path AWS receives, and to the object an S3 copy names in `x-amz-copy-source`. It does not see an action named in `X-Amz-Target` or in the body, or which AWS service a request is for.
- At most 8 request bodies are held to be hashed at one time, each for at most 60 seconds (`sigv4_busy`, `sigv4_body_timeout`).
- What was run: the signer against ten cases of AWS's published Signature Version 4 test suite, and an app using the AWS SDK for JavaScript v3 (S3, DynamoDB, IAM, Bedrock Runtime) started by `aquaman-coder exec`, against a local server that checks every signature with the stored secret using the SDK's own signer.
- `POST /broker/route` can name further variables for the program in `env` (for `aws`, the placeholder secret and the two endpoint variables). `exec` sets them, except names that change how programs are loaded and names the project binds itself.
- Built-in services: 27.

### Bitwarden works with the login item: `aquaman unlock`

With the `bitwarden` backend the daemon needed a Bitwarden session in the environment it was started from, so a daemon started at login by `aquaman service install` could not read the vault. Now:

- **The daemon starts and stays up while the vault is locked.** Requests that need a credential are answered with the code `vault_locked` and the fix `Run: aquaman unlock`. Health checks, status, request policy and everything else that needs no credential keep working.
- **`aquaman unlock`**, run by a person in a terminal, opens it. Bitwarden's own CLI asks for the master password (`bw unlock --raw`, attached to your terminal), so aquaman never sees it. aquaman takes the session that comes out and hands it to the running daemon over its Unix socket; the daemon checks it with `bw status` and keeps it in memory. It is not printed, not passed as a command argument, and not written to disk, the keychain or the login item.
- **`aquaman lock`** makes the daemon drop the session, the values it had cached and every yes given in an ask-first dialog. It does not run `bw`; to end the session everywhere, run `bw lock`.
- **A session that Bitwarden ends** (`bw lock`, `bw logout`, another `bw unlock`) puts the daemon back into `vault_locked` with the same fix. It does not have to be restarted.
- `aquaman status`, `aquaman doctor` and `aquaman init --agent` report a locked vault, and `aquaman service install` and `aquaman service status` list `aquaman unlock` as the step after each login.
- A coding agent's commands are not blocked while the vault is locked: they run without the project's credentials and the agent is told that a person has to unlock. `aquaman request` answers `vault_locked` without showing a dialog.
- The endpoint that takes the session answers on the Unix socket only, never on the loopback listener. Other software running as you can call it; with a session it already holds it makes the daemon read the vault `bw` is logged in to, and anything else is refused. It can also lock the daemon.
- The audit anchor is not read or written while the vault is locked, so entries written in that time are anchored after the next unlock.
- Starting the daemon from a shell with `export BW_SESSION=$(bw unlock --raw)` works as before.

How to use it: [Bitwarden: unlock after you log in](https://aquaman.sh/docs/autostart/#bitwarden-unlock-after-you-log-in).

## 0.20.0

The guides now show the cases people asked about: an item that is already in your vault on every host page, Bitwarden with Docker Sandboxes, OpenAI and Linux for Hermes, the model provider step for OpenClaw, and a new page for MCP servers.

Four fixes come with it, listed at the end. Everything the guides describe works with 0.19.0.

### A new page: credentials for MCP servers

[Credentials for MCP servers](https://aquaman.sh/docs/mcp/) covers three cases. A remote server with OAuth needs the host's own sign-in and not aquaman. A remote server that takes a fixed token in a header gets it from Claude Code's `headersHelper` running `aquaman get`. A stdio server gets a start command that reads the token with `aquaman get`, so nothing is in `.mcp.json`.

- Both aquaman forms were run inside Claude Code 2.1.327 with stand-in servers: both connected, and neither token appeared in Claude Code's output.
- `aquaman-coder exec` cannot wrap a stdio MCP server: its output redaction holds back the end of each reply until more output arrives. The page says so and gives the form that works.

### An item that is already in your vault, on every host page

Pointing a reference at an existing vault item (`aquaman request --from`, `aquaman credentials link`, since 0.19.0) was only described in the agent contract. It is now in the README, the agent contract's opening, `llms.txt` and each host guide.

- [Claude Code](https://aquaman.sh/docs/claude-code/) and [Codex](https://aquaman.sh/docs/codex/): a worked example with two tokens that are already in 1Password, for `npm test` and `npm publish --dry-run`, and what that gives and does not give compared with `op run`.
- [Docker Sandboxes](https://aquaman.sh/docs/docker-sandboxes/): the flow for an existing 1Password or Bitwarden item, where the Bitwarden session lives and why a daemon started at login does not have it, `sbx secret set-custom` for a service `sbx` has no definition for (run with `sbx` 0.54.0), and that cloud sandboxes take no `--command` source.

### Host guides

- [Hermes](https://aquaman.sh/docs/hermes/): the OpenAI variables next to the Anthropic ones, exactly as `aquaman hermes setup` writes them; which vault `aquaman setup` picks on Linux and what each needs; a full `secrets.aquaman.env` example.
- [OpenClaw](https://aquaman.sh/docs/openclaw/): which model providers are routed (Anthropic and OpenAI), what setup writes into `openclaw.json` for each, how to replace a key after rotating it, and something setup does that was not written down: a key that is already in `openclaw.json` as plain text is left there, and that provider is not routed until you remove it.
- [Keep an API key out of the app](https://aquaman.sh/docs/app-through-proxy/): the `services.yaml` entry for a basic-auth service on your own host with every field explained, what the app sends as its basic-auth pair, and the request policy syntax with a complete example.

### What to know before trusting it

The [section of that name](https://aquaman.sh/docs/compare/#what-to-know-before-trusting-it) on the comparison page states the same facts in a different order: first what you can check yourself (provenance, no install scripts, local and without an account, the test count and coverage floors, the attack tests and their pinned limits, the 0.18.2 assessment), then what counts against the project (one maintainer, no third-party audit, started in February 2026 and still 0.x, the advisory GHSA-9qh6-wffq-9m9v). Nothing was removed.

### Run by hand for this release

With the published 0.19.0 packages on macOS, before these pages were written:

- The dialogs: typing a value, approving a stored credential, approving a link to an existing vault item. Each ended in the status the contract documents, and a link written into `config.yaml` by hand was refused.
- The login item: `aquaman service install` approved in its dialog, launchd running the daemon, a restart one second after the daemon was killed, no restart after `aquaman stop`, a repeat install answering `already_installed`, and `aquaman service uninstall` leaving nothing behind.
- Both MCP recipes inside Claude Code 2.1.327, and an app on the Claude Agent SDK 0.3.327 routed with `--via-proxy`.
- `sbx` 0.54.0 storing a built-in and a custom secret whose source is `aquaman get`.

These used a KeePassXC database made for the run. Reads from 1Password, Bitwarden, HashiCorp Vault and Keeper items are covered by the automated tests against stand-ins for those tools, not by a live account.

### Fixes

- **`aquaman openclaw setup` could replace your `openclaw.json`.** If the file was not strict JSON, for example because it had comments or a trailing comma, setup started from an empty configuration and wrote that back, so everything else in the file was lost. Setup now stops, says why and leaves the file as it is. If you ran `aquaman openclaw setup` on such a file, restore it from your own copy.
- **`aquaman policy test` was wrong for `defaultAction: deny` policies.** A request that an `allow` rule matched was reported as "no matching rule", and a request that no rule matched ended in an error. It now names the rule or the default that decided. The proxy's own decisions were always right; only this command's output was not.
- **Commands on the KeePassXC vault printed their result and never returned.** `aquaman credentials list`, `aquaman audit verify` and other one-shot commands kept running because the vault's file watch held the process open. They exit now. The daemon was not affected.
- **`aquaman audit tail` could fail when the daemon rotated the log at that moment.** It reported "no such file". It now lists what is there. Nothing in the log was affected.

## 0.19.0

Use the secrets already in your vault, keep the daemon running across reboots, route apps that use basic auth, and an audit log that notices when it has been cut short.

### Use an item that is already in your vault

A reference can now point at an item you already keep in 1Password, Bitwarden, HashiCorp Vault, the Keychain, KeePassXC or Keeper, so you do not type the secret again.

```bash
# an agent asks, you approve the named item in a dialog
aquaman request aquaman://github/token --env GITHUB_TOKEN --from op://Private/GitHub/token

# or you start it yourself; the same dialog asks you
aquaman credentials link github/token op://Private/GitHub/token
aquaman credentials unlink github/token
```

| Vault | Locator |
|---|---|
| 1Password | `op://<vault>/<item>/[<section>/]<field>` |
| Bitwarden | `bw://<item id or exact name>/<field>` |
| HashiCorp Vault (KV v2) | `vault://<mount>/<path>#<field>` |
| Keychain, libsecret | `keychain://<service>/<account>` |
| KeePassXC | `keepassxc://<Group/.../Title>[#<field>]` |
| Keeper | `keeper://<UID>[/<field>]` |

- aquaman only reads a linked item. It never changes or deletes it, and `credentials add` and `delete` on a linked reference are refused.
- Linking is your decision, and you take it in a dialog the daemon shows. The dialog names the item, and nothing in your vault is read before you agree. `aquaman request --from` links the reference and declares it for commands (new status `linked`, exit code 0). `aquaman credentials link` links without declaring; it exits 0 when linked, 2 when you deny, 3 when nobody answers and 1 when the daemon refuses or is not running. A terminal is not taken as proof of a person. Only on a machine where no dialog can be shown does `aquaman credentials link` ask for a typed `yes` at the terminal instead.
- Your approval is recorded in the vault, and a link is read only with it. A link written into `config.yaml` by hand is not read. `aquaman credentials unlink` removes the link and the approval. Software that can write to your vault with the vault's own tools can write the approval record; aquaman does not guard against that.
- A running daemon picks up a new link without a restart, and writes a link that is added, changed or removed while it runs to the audit log. `aquaman credentials list` shows links, and `aquaman doctor` reports one that does not fit the configured vault.
- The `encrypted-file` and `systemd-creds` vaults hold only what aquaman wrote, so they take no links.
- Reading linked items was tested against stand-ins for each vault's tooling, not against live accounts.

Details: [the agent contract](https://aquaman.sh/docs/agent-setup/) and [what you approve](https://aquaman.sh/docs/approve/).

### Keep the daemon running across logins and reboots

```bash
aquaman service install     # launchd agent on macOS, systemd user unit on Linux
aquaman service status
aquaman service uninstall
```

- You decide: at a terminal the command asks y/N. Run without a terminal, for example by an agent, it asks you in a dialog. No flag skips the question. `aquaman init --agent ... --service` asks through the same dialog.
- No secret is written into the unit file. The `encrypted-file` vault needs its password in the daemon's environment, so it is refused, with the alternatives named. Settings that exist only in your shell (`VAULT_TOKEN`, `BW_SESSION` and similar) are listed by name, because a daemon started at login will not have them.
- On Linux without a login session the unit starts at boot only with lingering; aquaman reports `loginctl enable-linger` as a step for you and does not run it.
- `aquaman daemon` no longer refuses to start because of a pid file left by a crash whose number now belongs to another process.

Guide: [autostart](https://aquaman.sh/docs/autostart/).

### Route an app that uses basic auth

`--via-proxy` now works for APIs that take HTTP basic auth, such as Zendesk and Twilio. The app sends the local token as the user name or the password; aquaman replaces the pair with the stored one.

```bash
aquaman request aquaman://zendesk/api_token --env ZENDESK_API_TOKEN --via-proxy ZENDESK_API_URL
```

- A service on your own host (a Zendesk tenant) is a few lines in `services.yaml` with `authMode: basic`. Those entries are now checked: an unknown `authMode` or a malformed key list is refused.
- Slack bindings default to the `/api` base path, as OpenAI ones default to `/v1`.
- The [app guide](https://aquaman.sh/docs/app-through-proxy/) has a worked example of an app that calls Anthropic, Stripe read-only, Slack and Zendesk, and every client it shows is run in aquaman's tests: the Anthropic SDK and Slack in JavaScript and Python, OpenAI, Octokit, Stripe, and `fetch`, `requests` and `httpx` with basic auth. The Claude Agent SDK is described and not run in the tests.

### The audit log is anchored in your vault

Until now `aquaman audit verify` could not tell that the end of the log had been cut off, or that the log had been emptied, deleted or rebuilt: each leaves a chain that is valid on its own. The daemon now stores the position and hash of the newest entry in your vault, and `audit verify` compares the log with it.

- The anchor is written at most once a minute while requests arrive (every 15 minutes with 1Password, Bitwarden or Keeper, where a write can ask you to unlock the vault), never while idle, and once more when the daemon is stopped. `audit.anchorIntervalSeconds` sets the interval; `0` turns it off.
- `aquaman audit verify` now reads the vault, and fails if it cannot. `--chain-only` checks the chain alone; `--json` prints the result as JSON.
- `aquaman audit accept` sets the anchor to the log as it is, for a log you restored or deleted on purpose. It needs a terminal, a typed yes and no proxy running, and records the reset.
- Entries carry a sequence number, and the chain continues across log rotation. Existing logs keep working and are not rewritten; a log from before this release reads "not anchored yet" until the daemon writes its first anchor.
- It also notices entries removed from the beginning of the log: the anchor records where the log is supposed to begin, and that only moves when aquaman itself prunes old archives.
- `audit verify` and `audit tail` only read. They can be run while the daemon is writing, and they change nothing on disk.
- Several processes can write one log, for example the daemon and a proxy that OpenClaw starts: each entry is appended under a short lock and continues the chain from what is on disk. A process that cannot get the lock within two seconds refuses the request with `audit_unavailable`.
- What it does not detect: the removal of entries written since the last anchor, and a change made by software that can also write to your vault.

Fixes on the way: two log rotations within one millisecond no longer overwrite each other's archive; an entry recovered after a crash is no longer written twice; and running `audit verify` or `audit tail` beside a busy daemon could write an entry twice and break the chain, which reading no longer can.

### Behaviour changes to expect

- `aquaman audit verify` exits 1 when the vault cannot be read (locked, password not set). Use `--chain-only` where that is expected.
- Your vault gains up to two items that aquaman keeps for itself: `aquaman_internal/audit_anchor`, and `aquaman_internal/link_approvals` once you approve a link. Both are hidden from `aquaman credentials list` and cannot be read, declared, linked or changed through aquaman.
- With 1Password in desktop mode, an active daemon writes the anchor every 15 minutes, which can show an unlock prompt. Set `audit.anchorIntervalSeconds: 0` to turn anchoring off.
- `aquaman init --agent` adds a step to `human_steps` when the daemon does not start at login.
- `aquaman openclaw setup` and `aquaman openclaw migrate --auto` skip, and name, a plugin whose id is not a valid service name (uppercase letters, spaces, slashes). Its credentials stay in `openclaw.json`.
- Every audit write, and `aquaman audit rotate`, waits for a lock that the aquaman processes on one config directory share.

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
