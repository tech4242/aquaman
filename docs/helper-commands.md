# Give a host its key from your vault with `aquaman get`

Several agent hosts have a setting that takes a command and uses what it prints as a key. `aquaman get <reference>` is made for that setting: it prints one value you allowed, from the vault you already have, and writes an audit entry for each read.

```bash
aquaman broker allow aquaman://anthropic/api_key    # allow this reference to be handed out
aquaman get aquaman://anthropic/api_key | wc -c     # prints the bare value, no trailing newline
```

This is the [resolve hand-off](how-it-fits.md): the host receives the key and holds it. You get your vault as the source, an allow-list and a record of each read. You do not get isolation from the host, and request policies do not apply. Where a host has an aquaman integration that keeps the key out of its process ([OpenClaw](openclaw.md), [Hermes](hermes.md)), use that instead.

## If you are an agent

- **The person runs `aquaman broker allow`.** It decides which keys may leave the vault. Do not run it for a reference the person has not asked for.
- **Never run `aquaman get` yourself to read a value into the conversation.** It refuses a terminal without `--show` for that reason.
- **The daemon must be running** when the host calls the command: [start it at login](autostart.md).

## What every host has in common

- **The command finds the daemon through `HOME`** (the socket is `~/.aquaman/proxy.sock`) or `AQUAMAN_CONFIG_DIR`. A host that runs the command with a different home needs `AQUAMAN_CONFIG_DIR` set for it. Each section says what the host passes on.
- **A refusal prints nothing on stdout and exits 1,** with the reason and the fix on stderr. That happens for a reference that is not allowed, a stopped daemon and a locked vault.
- **Removing the allowance later (`aquaman broker revoke`) stops the next read.** A host that already holds the value keeps it until it asks again. Revoking does not remove the key: for a service on the proxied list, requests sent through the proxy on your machine still get it.

## Claude Code: `apiKeyHelper`

In `~/.claude/settings.json`:

```json
{
  "apiKeyHelper": "aquaman get aquaman://anthropic/api_key"
}
```

- Claude Code runs the command once when it starts and again after the time in `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, or when the API answers 401. It sends the value as both `Authorization: Bearer` and `x-api-key`.
- The command inherits Claude Code's environment, plus the `env` block of the settings file. If Claude Code runs with another home, add `"env": { "AQUAMAN_CONFIG_DIR": "/path/to/.aquaman" }`.
- **When the command fails,** Claude Code shows aquaman's message, still sends the request with an empty key, and gives up after three attempts. The API rejects the empty key; nothing else stops the request.
- Claude Code's documentation (read 2026-11-27) says helper commands run outside its sandbox, and that its own `sandbox.credentials` setting takes environment variable names and file paths, not a command. So that setting is not a place for `aquaman get` today.

## Codex: a provider's `auth` command

Codex accepts an auth command on a provider you define. It refuses one on its built-in `openai` provider: `model_providers contains reserved built-in provider IDs`. Define your own in `~/.codex/config.toml`:

```toml
model_provider = "my-api"

[model_providers.my-api]
name = "My API"
base_url = "https://llm.example.com/v1"
wire_api = "responses"

[model_providers.my-api.auth]
command = "aquaman"
args = ["get", "aquaman://openai/api_key"]
```

- Codex runs the command once per start and again when the API answers 401. It sends the value as `Authorization: Bearer`.
- `command` is looked up on Codex's `PATH`. An absolute path to `aquaman` works too; `node` still has to be on the `PATH`.
- The command inherits Codex's environment. `AQUAMAN_CONFIG_DIR` reaches it only if Codex itself was started with it.
- **When the command fails,** Codex first sends several requests with no `Authorization` header, then stops and shows aquaman's message.

For commands Codex runs in your project, use the [Codex guide](codex.md): that path keeps the key out of the conversation.

## Hermes: `key_cmd` on a provider

`aquaman hermes setup` keeps provider keys out of the Hermes process and is the better choice. Without it, a provider in `~/.hermes/config.yaml` can take its key from a command:

```yaml
providers:
  my-api:
    base_url: "https://llm.example.com/v1"
    transport: chat_completions
    default_model: my-model
    key_cmd: "aquaman get aquaman://openai/api_key"
```

- Hermes runs the command through a shell from its own install directory, about twice per chat, and sends the value as `Authorization: Bearer` to the provider's base URL, model discovery requests included.
- **When the command fails,** Hermes sends no chat request and reports `key_cmd for provider ... exited 1`. It does not show aquaman's message: run the command yourself to see it.
- Hermes also has a command secret source (`secrets.command`). It expects `KEY=VALUE` lines, not a bare value, and it starts Hermes without the key when the command fails. Use aquaman's own [secret source](hermes.md) for project secrets instead.

## OpenClaw: an exec secrets provider

The [aquaman plugin](openclaw.md) keeps provider keys out of the gateway and is the better choice. Without it, an exec provider in `openclaw.json` can run `aquaman get`:

```json
{
  "secrets": {
    "providers": {
      "aquaman_openai": {
        "source": "exec",
        "command": "/absolute/path/to/node",
        "args": ["/absolute/path/to/aquaman-proxy/dist/cli/index.js", "get", "aquaman://openai/api_key"],
        "passEnv": ["HOME"],
        "jsonOnly": false
      }
    }
  }
}
```

A provider then refers to it with `"apiKey": { "source": "exec", "provider": "aquaman_openai", "id": "value" }`.

- **`command` must be a real file, not a symlink,** so the `aquaman` command that npm installs is refused. Give Node's own path and the CLI file as the first argument. `npm root -g` prints the directory that holds `aquaman-proxy`.
- **`jsonOnly: false` is needed.** With the default, OpenClaw runs the command and then rejects the bare value.
- **OpenClaw passes almost no environment.** `passEnv: ["HOME"]` lets the command find the daemon; an `env` map with `AQUAMAN_CONFIG_DIR` works as well.
- **A running gateway keeps the value.** It reads the key once at start. Stopping the daemon or revoking the reference does not take the key away from a gateway that is already running, and `openclaw secrets reload` keeps the last value when the command fails. A gateway started while the daemon is down starts without the key and refuses requests for that provider.
- **When the command fails,** OpenClaw sends nothing and reports the reference as unresolved. It does not show aquaman's message.

## What was run

On 2026-11-27, on macOS, each host was run in a home of its own against a stand-in API that recorded the headers it received, with made-up keys in an encrypted-file vault:

- Claude Code 2.1.332, `claude -p`.
- Codex 0.172.0, `codex exec`.
- Hermes 0.23.4, `hermes chat`.
- OpenClaw 2026.11.10, `openclaw agent --local` and a local gateway.

For each: the stand-in received the stored value, aquaman's audit log had the read, and the failure cases above (a reference that is not allowed, a stopped daemon) behaved as described. No host was run against its real provider.
