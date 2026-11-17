# Keep an API key out of the app a coding agent builds

By default aquaman sets a key as an environment variable for each command a coding agent runs, so the command, and the app it starts, hold the key while they run. This page is the other mode: the app is sent through aquaman's local proxy and holds only a local token. The proxy adds the real key on the way to the API, and your request policies apply to what the app sends.

Requires aquaman 0.18.1 or later, and an app that reads its API base URL from the environment.

## Set up

```bash
aquaman init --agent claude-code --no-hooks --loopback        # or: --agent codex
aquaman request aquaman://stripe/secret_key --env STRIPE_SECRET_KEY --via-proxy STRIPE_API_BASE
aquaman-coder exec -- npm start
```

- `--loopback` turns on a listener on `127.0.0.1` (port 8585 unless configured). It only answers requests that carry one of the proxy's own tokens. It is off until you ask for it, and `init` restarts the daemon if it was running without it.
- `--via-proxy STRIPE_API_BASE` records a route. In commands run for the project, `STRIPE_API_BASE` is the proxy's URL for the service (`http://127.0.0.1:8585/stripe`) and `STRIPE_SECRET_KEY` is a route token, not the key. The route token is made fresh each time the daemon starts, is accepted only for forwarding to services a project has routed, and is refused by every endpoint that hands out a credential.
- The app sends its requests to that URL with that token as its key, exactly as it would send the real one. The proxy checks the token, checks your policy, removes the token, adds the key from your vault and forwards the request.

Binding the same variable again without `--via-proxy` goes back to setting the value. While a reference is bound only through the proxy, aquaman does not hand its value to anything: `aquaman get` and `aquaman-coder exec` in another mode are refused for it.

## What the app has to do

Read the base URL from the environment, falling back to the vendor's address. That is the only change, and it is what makes the same code work in CI and production, where the variable is unset and the key comes from that platform's secrets.

```js
// OpenAI: the SDK already reads OPENAI_BASE_URL and OPENAI_API_KEY from the environment
const openai = new OpenAI();

// GitHub
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, baseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com' });

// Stripe: its SDK takes a host but not a path, so hand it a fetch that swaps the origin
const base = process.env.STRIPE_API_BASE;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, base
  ? { httpClient: Stripe.createFetchHttpClient((url, init) => fetch(String(url).replace('https://api.stripe.com', base), init)) }
  : {});
```

These three were run against a local server to confirm the path and header each sends (openai 7.57.0, @octokit/rest 22.0.1, stripe 23.1.0).

```bash
aquaman request aquaman://openai/api_key --env OPENAI_API_KEY --via-proxy OPENAI_BASE_URL    # URL ends in /openai/v1
aquaman request aquaman://github/token --env GITHUB_TOKEN --via-proxy GITHUB_API_URL
```

`--base-path` adds a path to the URL when a client expects one. It defaults to `/v1` for `openai`, where the SDK's base URL includes the version, and to nothing otherwise.

A client library that cannot be given a base URL cannot be routed. Bind that key without `--via-proxy`.

## Which services can be routed

A service the proxy has a definition for and injects a request header for. Built in:

| Service | Reference | Service | Reference |
|---|---|---|---|
| anthropic | `aquaman://anthropic/api_key` | stripe | `aquaman://stripe/secret_key` |
| openai | `aquaman://openai/api_key` | elevenlabs | `aquaman://elevenlabs/api_key` (token in `xi-api-key`) |
| github | `aquaman://github/token` | slack | `aquaman://slack/bot_token` |
| xai | `aquaman://xai/api_key` | discord | `aquaman://discord/bot_token` |
| mistral | `aquaman://mistral/api_key` | matrix | `aquaman://matrix/access_token` |
| huggingface | `aquaman://huggingface/api_key` | mattermost | `aquaman://mattermost/bot_token` |
| cloudflare-ai | `aquaman://cloudflare-ai/api_token` | line, telnyx, zalo | see `aquaman services list` |

The client sends the route token wherever it would send the key: `Authorization`, `x-api-key`, or the service's own header. The reference has to name the key the proxy injects for the service, which is the one shown. Twitch is left out because its API needs a second credential the proxy does not add. `aquaman request` checks this before anyone is asked.

For any other API, add a definition to `~/.aquaman/services.yaml`:

```yaml
services:
  - name: linear
    upstream: https://api.linear.app
    authHeader: Authorization
    authPrefix: ""            # "Bearer " for bearer tokens; empty when the API takes the bare key
    credentialKey: api_key
```

Then `aquaman request aquaman://linear/api_key --env LINEAR_API_KEY --via-proxy LINEAR_API_URL`. `aquaman services validate` checks the file. A built-in definition cannot be replaced from this file, so a changed config cannot send a built-in service's key to another host. Restart the daemon after editing it (`aquaman stop`, then `aquaman init --agent <agent> --loopback`).

## Limit what the key can do

Because the request passes through the proxy, the rules in `~/.aquaman/config.yaml` apply to it:

```yaml
policy:
  stripe:
    defaultAction: allow
    rules:
      - { method: DELETE, path: "/v1/customers/**", action: deny }
      - { method: POST, path: "/v1/payouts", action: deny }
```

A denied request gets a 403 from the proxy and no key. `aquaman policy test stripe DELETE /v1/customers/cus_1` shows what a rule set decides. Each forwarded request is written to the audit log.

## What this does and does not give you

- The app, its dependencies and anything it logs hold a token that is useless off your machine and that the API rejects. The key is never in the app's memory or environment.
- The route token is not a secret from other software on your machine. A local process that reads it can send requests to the routed services, within your policy; it cannot use it to obtain a key. A process running as you can also change the binding itself, so this keeps the key from leaking through the app. It is not a boundary between programs running as you.
- The listener is plain HTTP on a loopback address. aquaman refuses to start it on any other address, and refuses requests addressed to it by any name other than `127.0.0.1` or `localhost`.
- One route token covers every service your projects have routed, and nothing else. Policy rules narrow what it can do on each. A long-running app has to be started again after the daemon restarts, because the token changes.
- Only HTTP APIs with header authentication. For everything else the variable is set to the value, as before.
- It is for your machine. In CI and production leave the URL variable unset and supply the key from that platform's secrets.

Compared with a tool that intercepts all HTTPS traffic through a local certificate authority (fnox `proxy run`, Claude Code's sandbox masking): aquaman needs no certificate in your trust store and the app's TLS to the proxy is not terminated by anything, because the app talks plain HTTP to a local address and the proxy makes the HTTPS call. The cost is that the app has to accept a base URL.
