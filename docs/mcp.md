# Credentials for MCP servers

An MCP server that talks to an API needs a token, and the usual place for it is the `env` or `headers` entry of `.mcp.json`, which is a file in the repository that the agent can read. This page shows how to keep the token in your vault and out of that file. Which way applies depends on how the server authenticates and how it is started:

| The server | What to use |
|---|---|
| Remote, and offers OAuth sign-in | The host's own sign-in. aquaman is not needed |
| Remote, and takes a fixed token in a request header | Claude Code's `headersHelper`, running `aquaman get` |
| Local, started by the host over stdio | A start command that reads the token with `aquaman get` |

Facts about Claude Code on this page are from its [MCP documentation](https://code.claude.com/docs/en/mcp), read on 2026-11-18. Both aquaman forms below were run inside Claude Code 2.1.327 with aquaman 0.19.0, a stand-in remote server that refuses a request without the right token, and a stand-in stdio server: both servers connected, a tool call on each worked, and neither token appeared in Claude Code's output.

## A remote server with OAuth

Use the host's sign-in and nothing else. In Claude Code you add the server by URL and sign in from `/mcp` (or with `claude mcp login <name>`). Claude Code stores the tokens itself and refreshes them, and `.mcp.json` holds only the URL. There is no token to keep out of a file, so aquaman has nothing to add here.

## A remote server that takes a token in a header

Claude Code can run a command each time it connects to a server and send the headers that command prints. That setting is `headersHelper`, and the command can be `aquaman get`, so the token is read from your vault at connection time.

Once, in your own terminal:

```bash
npm install -g aquaman-proxy
aquaman setup                                        # pick your vault, if you have not yet
aquaman daemon &                                     # or: aquaman init --agent claude-code --no-hooks, which starts it
aquaman credentials add acme-mcp token               # asks for the value, hidden
aquaman broker allow aquaman://acme-mcp/token        # allow it to be handed out
```

If the token is already an item in your vault, link it in place of `credentials add`: `aquaman credentials link acme-mcp/token '<locator>'`, which you approve in a dialog ([locator forms](agent-setup.md#an-item-that-is-already-in-the-vault)). `acme-mcp` and `token` are names you choose.

A helper script, for example `~/bin/mcp-acme-headers.sh`, made executable:

```sh
#!/bin/sh
# Prints the request headers for one MCP server as JSON. The token comes from aquaman.
token="$(aquaman get aquaman://acme-mcp/token)" || exit 1
printf '{"Authorization": "Bearer %s"}' "$token"
```

And the server entry, with the script's absolute path:

```json
{
  "mcpServers": {
    "acme": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headersHelper": "/Users/you/bin/mcp-acme-headers.sh"
    }
  }
}
```

What Claude Code's documentation says about the helper, which is what the script is written to:

- It must write a JSON object of string keys and values to stdout. Claude Code runs it in a shell and gives up after 10 seconds.
- It runs on each connection, at session start and on reconnect, and again when a tool call gets a 401 or 403. Claude Code does not cache its output, so each connection asks aquaman again.
- For a server in a project's `.mcp.json`, it runs only after you have accepted the trust dialog for that folder, and without the environment variables whose names look like credentials. `aquaman get` needs none of them: it asks the daemon over its socket.
- The working directory depends on where the server is configured, which is why the path is absolute.
- When the helper returns an `Authorization` header, Claude Code uses it and does not fall back to OAuth for that server.

Where the token is: in the helper's process and in Claude Code's own process, which sends the header. It is not in `.mcp.json`, not in an environment variable of your shell or of the agent's commands, and not in the conversation. Each connection is one entry in `aquaman audit tail`.

Limits:

- `printf` does not escape the value. A token that contains `"` or `\` would make the output invalid JSON; API tokens normally contain neither.
- If the daemon is not running, the script exits 1 and prints nothing to stdout, and aquaman's message on stderr names the command that starts it. The server then has no header until the daemon is back and you reconnect from `/mcp`.
- With a vault that asks you to unlock for a read (1Password in desktop-app mode), the first connection can take longer than the 10 seconds Claude Code allows. Reconnect from `/mcp`.
- Whether a given vendor's MCP server accepts a fixed token in a header at all is the vendor's decision. Check their documentation.
- `headersHelper` is a Claude Code setting.

## A stdio server the host starts

A stdio server is a program the host starts from the `command` and `args` in `.mcp.json`, usually with its token in `env`. Make the command a shell that reads the token from aquaman, puts it in the server's environment, and then becomes the server:

```json
{
  "mcpServers": {
    "github-tools": {
      "command": "/bin/sh",
      "args": ["-c", "GITHUB_TOKEN=\"$(aquaman get aquaman://github/token)\" || exit 1; export GITHUB_TOKEN; exec node ./mcp/server.js"]
    }
  }
}
```

Or keep the shell part in a script and point `command` at it:

```sh
#!/bin/sh
# Starts the MCP server with its token read from aquaman. Nothing secret is in this file.
GITHUB_TOKEN="$(aquaman get aquaman://github/token)" || exit 1
export GITHUB_TOKEN
exec node "$(dirname "$0")/server.js"
```

The setup is the same as above: the token stored or linked as `github/token`, `aquaman broker allow aquaman://github/token`, and the daemon running.

- **`exec` matters.** The shell is replaced by the server, so the host's pipes are the server's own stdin and stdout and nothing sits between them.
- **`|| exit 1` matters.** If aquaman cannot hand out the token (the daemon is not running, the reference is not declared), the server does not start, and aquaman's message with the fix is written to the server's stderr. Without it the server would start with an empty token.
- **Where the token is:** in the environment of the server process, for as long as it runs. It is not in `.mcp.json`, not in the host's own environment, and not in the environment of the commands the agent runs. Each server start is one entry in `aquaman audit tail`.
- **The server holds the real value.** This keeps the token out of files and out of the agent's reach through its shell; it does not keep it from the server itself. Nothing redacts what the server sends back, so a server that returns its own token in a tool result puts it in the conversation.
- **The token is read once, at start.** After you replace it in the vault, restart the server (in Claude Code, reconnect it from `/mcp`).
- `aquaman` has to be on the `PATH` the host starts servers with. If it is not, write the absolute paths of `node` and `aquaman`. Claude Code starts a stdio server in the project folder, so a relative path such as `./mcp/server.js` is found there.
- Claude Code expands `${VAR}` in `command`, `args` and `env` from its own environment. The line above uses `$(...)` and no `${...}`, so nothing in it is expanded by Claude Code. A token supplied as `${GITHUB_TOKEN}` would have to be in Claude Code's own environment, which is what this page avoids.

What was run, in Claude Code 2.1.327: the entry above, with a stand-in server that reports whether its variable is set and never the value. The server connected, its tool answered with the variable set, and `aquaman audit tail` showed one read for the start. Outside Claude Code, with the reference revoked, the server did not start and its stderr carried aquaman's fix.

### Do not wrap a stdio server in `aquaman-coder exec`

`aquaman-coder exec -- node ./mcp/server.js` does not work as a stdio MCP server. `exec` redacts the command's output as a stream and holds back the last few bytes until more output arrives, so the end of each reply reaches the host only when the server writes its next message, and the host waits on a reply that is incomplete. In the same test as above, the reply to the first request was still incomplete after five seconds and completed only when the second reply was written. `--raw` turns redaction off, but it only works with a terminal on stdout, which a host does not give a server.

For the same reason a stdio server cannot be given a route token in place of the value today: `--via-proxy` bindings are applied by `aquaman-coder exec`.

## If you are an agent

- **OAuth first.** If the server offers OAuth, tell the user to sign in from the host and do not propose aquaman for it.
- **Do not ask for the token in the conversation and do not write it into `.mcp.json`**, `env` included. If aquaman is set up, `aquaman request aquaman://<service>/<key> --json` lets the user supply the value in a dialog and declares the reference; with `--from '<locator the user gave you>'` it points at an item they already have. See [the agent contract](agent-setup.md).
- **Changing `.mcp.json` or adding a helper script changes how the host starts a server.** Say what you will change before you do it, and tell the user they need to reconnect or restart the server afterwards.
- **The daemon has to be running when the host connects or starts the server.** It is gone after a reboot unless the user installed the login item: [Start the aquaman daemon at login](autostart.md).

More: [Claude Code](claude-code.md) · [contract for agents](agent-setup.md)
