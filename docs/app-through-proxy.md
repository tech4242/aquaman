# Keep an API key out of the app a coding agent builds

By default aquaman sets a key as an environment variable for each command a coding agent runs, so the command, and the app it starts, hold the key while they run. This page is the other mode: the app is sent through aquaman's local proxy and holds only a local token. The proxy adds the real key on the way to the API, and your request policies apply to what the app sends.

<!-- diagram: route -->

How a request travels:

1. Your app sends its request to aquaman on `127.0.0.1`, with a local token where the key would be. The token and the address come from its environment.
2. aquaman checks your request policy, reads the real key from your vault, puts it in place of the token and logs the use.
3. The request goes on to the API over HTTPS with the real key.


Requires aquaman 0.18.1 or later, and an app that reads its API base URL from the environment. Services that use HTTP basic auth (Zendesk, Twilio) need 0.19.0. AWS, where the proxy signs each request, needs 0.21.0 and has [its own page](aws.md).

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

A client library that cannot be given a base URL cannot be routed. Bind that key without `--via-proxy`.

## A worked example: an agentic app that calls four APIs

A support agent that asks Claude what to do, reads customers from Stripe, posts to Slack and reads tickets from Zendesk. Each key stays in the vault; the app holds one route token and four local URLs.

Zendesk's host is per tenant, so it is not built in. Add it to `~/.aquaman/services.yaml` (next to `config.yaml`) before starting the daemon:

```yaml
services:
  - name: zendesk
    upstream: https://yourcompany.zendesk.com
    authMode: basic
    authHeader: Authorization
    credentialKey: email                    # the user name: you@yourcompany.com/token
    additionalCredentialKeys: [api_token]   # the password: the API token
```

Then, in the project directory:

```bash
aquaman init --agent claude-code --no-hooks --loopback

aquaman request aquaman://anthropic/api_key  --env ANTHROPIC_API_KEY --via-proxy ANTHROPIC_BASE_URL
aquaman request aquaman://stripe/secret_key  --env STRIPE_SECRET_KEY --via-proxy STRIPE_API_BASE
aquaman request aquaman://slack/bot_token    --env SLACK_BOT_TOKEN   --via-proxy SLACK_API_URL       # URL ends in /slack/api
aquaman request aquaman://zendesk/api_token  --env ZENDESK_API_TOKEN --via-proxy ZENDESK_API_URL
aquaman credentials add zendesk email        # the user name half: you@yourcompany.com/token

aquaman-coder exec -- node support-agent.mjs
```

Each `aquaman request` shows you a dialog to type the key into. The agent never sees it. Zendesk needs both halves of its pair in the vault: the routed one (`api_token`) and the user name, which you add yourself. `aquaman-coder exec` says which one is missing if either is.

Make Stripe read-only for the app in `~/.aquaman/config.yaml`, then restart the daemon (`aquaman stop`, then `aquaman init --agent claude-code --no-hooks --loopback`):

```yaml
policy:
  stripe:
    defaultAction: deny
    rules:
      - { method: GET, path: "/v1/**", action: allow }
```

The app:

```js
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import { WebClient } from '@slack/web-api';

// Anthropic: the SDK reads ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from the environment
const anthropic = new Anthropic();

// Stripe: its SDK takes a host but not a path, so hand it a fetch that swaps the origin
const base = process.env.STRIPE_API_BASE;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, base
  ? { httpClient: Stripe.createFetchHttpClient((url, init) => fetch(String(url).replace('https://api.stripe.com', base), init)) }
  : {});

// Slack: the base URL is the slackApiUrl option; unset, the client uses https://slack.com/api/
const slack = new WebClient(process.env.SLACK_BOT_TOKEN, { slackApiUrl: process.env.SLACK_API_URL });

// Zendesk: basic auth, "{email}/token" as the user name and the API token as the password
const zendesk = process.env.ZENDESK_API_URL ?? 'https://yourcompany.zendesk.com';
const zendeskAuth = Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`).toString('base64');

const tickets = await (await fetch(`${zendesk}/api/v2/tickets.json`, { headers: { Authorization: `Basic ${zendeskAuth}` } })).json();
const customers = await stripe.customers.list({ limit: 3 });        // allowed: a GET
const reply = await anthropic.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: `Draft a reply to ticket ${tickets.tickets[0].id} for ${customers.data.length} customers.` }],
});
const posted = await slack.chat.postMessage({ channel: 'C0SUPPORT', text: reply.content[0].text });

let refund;
try {
  await stripe.refunds.create({ charge: 'ch_1' }, { maxNetworkRetries: 0 });
  refund = 'sent';
} catch (err) {
  refund = `refused with ${err.statusCode}`;                         // 403 from the proxy; Stripe never sees it
}
```

What the app's environment holds while it runs: `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `SLACK_BOT_TOKEN` and `ZENDESK_API_TOKEN` are all the same `aqm_rt_...` token, and the four URL variables point at `http://127.0.0.1:8585/<service>`. `ZENDESK_EMAIL` is an ordinary setting of yours. For basic auth the proxy discards the whole `Authorization` header the app sent and builds a new one from the two stored values, so the user name the app sends does not matter.

## A basic-auth service on your own host, field by field

The Zendesk entry from the example, with every field. The file is `~/.aquaman/services.yaml`, next to `config.yaml`; create it if it does not exist.

```yaml
services:
  - name: zendesk                           # your name for the service
    description: Zendesk Support, yourcompany   # optional, shown by `aquaman services list`
    upstream: https://yourcompany.zendesk.com   # your tenant's host
    authMode: basic                         # build an HTTP basic Authorization header
    authHeader: Authorization               # required for basic and header modes
    credentialKey: email                    # vault key that holds the user name
    additionalCredentialKeys: [api_token]   # vault key that holds the password
```

| Field | Meaning |
|---|---|
| `name` | Lowercase letters, digits, `.`, `_` and `-`. It is the service part of references (`aquaman://zendesk/...`) and the first segment of the proxy URL (`http://127.0.0.1:8585/zendesk`). It cannot be the name of a built-in service. On the `1password` and `systemd-creds` backends it also must not begin with a built-in service's name and a hyphen (`openai-eu`), or be the first part of one (`cloudflare`, because `cloudflare-ai` is built in): those backends join service and key into one item name, and the proxy refuses a request whose key would be read from a built-in service's item (`service_item_collision`) |
| `description` | Optional text |
| `upstream` | Where the proxy sends the request. `http` or `https`; only the scheme, host and port are used. The path the app sends after `/zendesk` is the path the API receives |
| `authMode` | `basic` here. Left out, it is `header`, which puts one credential into `authHeader` after `authPrefix`. The other modes (`url-path`, `oauth`, `none`) cannot be routed with `--via-proxy` |
| `authHeader` | Has to be present. For `basic` the proxy always writes `Authorization` |
| `credentialKey` | The first half of the pair: the proxy reads `zendesk/email` from the vault and uses it as the user name |
| `additionalCredentialKeys` | A list of key names. The first one is the password: the proxy reads `zendesk/api_token`. An empty list means an empty password |

`aquaman services validate` checks the file and `aquaman services list` shows the entry marked `(custom)`.

What goes in the vault, for Zendesk's API-token sign-in:

| Reference | Value | How it gets there |
|---|---|---|
| `aquaman://zendesk/email` | `you@yourcompany.com/token` (Zendesk's user name form for token sign-in: your address followed by `/token`) | `aquaman credentials add zendesk email` |
| `aquaman://zendesk/api_token` | The API token | `aquaman request aquaman://zendesk/api_token --env ZENDESK_API_TOKEN --via-proxy ZENDESK_API_URL` |

One `--via-proxy` binding is enough for the pair. It names the key the app must not hold; the other half is only stored, and needs no binding and no variable.

What the app sends, and what the API receives:

| | User name | Password |
|---|---|---|
| The app sends `Authorization: Basic base64(user:password)` with | anything, for example `you@yourcompany.com/token` | the value of `ZENDESK_API_TOKEN`, which is the route token `aqm_rt_...` |
| The proxy sends on | the stored `zendesk/email` | the stored `zendesk/api_token` |

The proxy accepts the route token in either position, so a client that can only set the user name works too. It discards the header the app sent and builds a new one from the two stored values, so the user name the app sends is never forwarded. A request that carries none of the proxy's own tokens is refused with 401.

## Clients

Which variable or option carries the base URL, which carries the key, and the base path to bind with. `aquaman-coder bind` and `aquaman request` add `/v1` for `openai` and `/api` for `slack` on their own; `--base-path` sets it for anything else.

| Client | Base URL | Key | Base path |
|---|---|---|---|
| `@anthropic-ai/sdk` (JavaScript) | `ANTHROPIC_BASE_URL` (or `baseURL`) | `ANTHROPIC_API_KEY` (or `apiKey`) | none |
| `anthropic` (Python) | `ANTHROPIC_BASE_URL` (or `base_url`) | `ANTHROPIC_API_KEY` (or `api_key`) | none |
| `openai` (JavaScript) | `OPENAI_BASE_URL` | `OPENAI_API_KEY` | `/v1` |
| `@octokit/rest` | `baseUrl` option | `auth` option | none |
| `stripe` (JavaScript) | a fetch client that swaps the origin, as above | first constructor argument | none |
| `@slack/web-api` | `slackApiUrl` option | first constructor argument | `/api` |
| `slack_sdk` (Python) | `base_url` argument | `token` argument | `/api` |
| `fetch`, `requests`, `httpx` with basic auth | your own variable | the password (or the user name) of the pair | none |

The Slack clients append the method name to their base URL (`chat.postMessage`), and the real one ends in `/api/`, so the proxy URL has to end in `/slack/api`. The Anthropic SDKs append `/v1/messages` themselves.

Python:

```python
import os
import anthropic, requests
from slack_sdk import WebClient

client = anthropic.Anthropic()        # reads ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY

slack = WebClient(
    token=os.environ["SLACK_BOT_TOKEN"],
    base_url=os.environ.get("SLACK_API_URL", "https://slack.com/api/"),
)

zendesk = os.environ.get("ZENDESK_API_URL", "https://yourcompany.zendesk.com")
tickets = requests.get(
    f"{zendesk}/api/v2/tickets.json",
    auth=(f"{os.environ['ZENDESK_EMAIL']}/token", os.environ["ZENDESK_API_TOKEN"]),
    timeout=30,
)
```

`httpx.get(url, auth=(user, token))` works the same way.

Other JavaScript clients:

```js
// OpenAI: the SDK already reads OPENAI_BASE_URL and OPENAI_API_KEY from the environment
const openai = new OpenAI();

// GitHub
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, baseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com' });
```

```bash
aquaman request aquaman://openai/api_key --env OPENAI_API_KEY --via-proxy OPENAI_BASE_URL    # URL ends in /openai/v1
aquaman request aquaman://github/token --env GITHUB_TOKEN --via-proxy GITHUB_API_URL
```

Every client in the table is run in aquaman's test suite as its own process against a real proxy and a local server in place of the vendor. Each test checks that the vendor received the real credential and never the token, and that the process's environment held no real credential. Versions run: `@anthropic-ai/sdk` 1.10.0, `openai` 7.59.0, `@octokit/rest` 22.0.1, `stripe` 23.1.0, `@slack/web-api` 8.4.0; Python `anthropic` 2.10.0, `slack_sdk` 3.47.0, `requests` 2.34.2, `httpx` 0.28.1.

**Claude Agent SDK.** Bind it like the Anthropic SDK: `--env ANTHROPIC_API_KEY --via-proxy ANTHROPIC_BASE_URL`, no base path. The SDK starts the Claude Code program, which inherits the app's environment and takes both variables from it; if you pass the `env` option, which replaces the environment, include both. Run with `@anthropic-ai/claude-agent-sdk` 0.3.327 and aquaman 0.19.0: an app started with `aquaman-coder exec` had the route token in `ANTHROPIC_API_KEY`, the SDK reported `ANTHROPIC_API_KEY` as its key source, and its requests arrived at the proxy and were forwarded to Anthropic with the vault's key, each one an entry in `aquaman audit tail`. This is checked by hand at release time and is not part of the automated tests, which do not start Claude Code.

## Which services can be routed

A service the proxy has a definition for and injects a request header or HTTP basic auth for, and AWS, whose requests the proxy signs. Built in, with a header:

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

Built in, with basic auth:

| Service | User name | Password |
|---|---|---|
| twilio | `aquaman://twilio/account_sid` | `aquaman://twilio/auth_token` |
| nextcloud | `aquaman://nextcloud/api_user` | `aquaman://nextcloud/api_password` |
| bluebubbles | `aquaman://bluebubbles/password` | none |

For a basic-auth service the route can name either key of the pair, usually the password. The app sends ordinary basic auth with the route token in that position, and the proxy accepts the token as either the user name or the password. Both keys have to be in the vault. Only the routed key is withheld from `aquaman get` and from being set as a value; if the app also needs the user name as a plain value, bind it without `--via-proxy`. The `nextcloud` and `bluebubbles` definitions point at `localhost`; for your own server add an entry under another name to `services.yaml`.

Built in, signed by the proxy: `aws`, routed by `aquaman://aws/access_key_id`. The app's AWS client signs with the route token and a placeholder secret, and the proxy signs again with the stored keys. Setup, the hosts it reaches and what it refuses are in [Call AWS without giving the app your AWS keys](aws.md).

For any other API, add a definition to `~/.aquaman/services.yaml`:

```yaml
services:
  - name: linear
    upstream: https://api.linear.app
    authHeader: Authorization
    authPrefix: ""            # "Bearer " for bearer tokens; empty when the API takes the bare key
    credentialKey: api_key
  - name: zendesk
    upstream: https://yourcompany.zendesk.com
    authMode: basic
    authHeader: Authorization
    credentialKey: email                    # user name
    additionalCredentialKeys: [api_token]   # password
```

Then `aquaman request aquaman://linear/api_key --env LINEAR_API_KEY --via-proxy LINEAR_API_URL`. `aquaman services validate` checks the file: it refuses an `authMode` it does not know, and `additionalCredentialKeys` that are not a list of distinct key names. Only the origin of `upstream` is used; the path the app sends is the path the API receives. A built-in definition cannot be replaced from this file, so a changed config cannot send a built-in service's key to another host. Restart the daemon after editing it (`aquaman stop`, then `aquaman init --agent <agent> --loopback`).

Services that put the token in the URL path (Telegram), use an OAuth exchange (MS Teams, Feishu, Google Chat) or are stored only (Nostr, Tlon) cannot be routed this way.

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

A denied request gets a 403 from the proxy and no key. `aquaman policy test stripe DELETE /v1/customers/cus_1` shows what a rule set decides. Each forwarded request is written to the audit log. The read-only form in the worked example (`defaultAction: deny` with one `allow` rule for `GET`) is the stricter shape: anything you did not allow is refused. The rules apply to basic-auth services in the same way.

### The policy syntax

Policies live under `policy` in `~/.aquaman/config.yaml`, one entry per service name. A complete example: Stripe read-only, and Zendesk read-only except that a ticket can be updated and nothing under `users` can be touched.

```yaml
policy:
  stripe:
    defaultAction: deny                  # what happens when no rule matches
    rules:
      - { method: GET, path: "/v1/**", action: allow }
  zendesk:
    defaultAction: deny
    rules:
      - { method: "*", path: "/api/v2/users/**", action: deny }
      - { method: GET, path: "/api/v2/**", action: allow }
      - { method: PUT, path: "/api/v2/tickets/*", action: allow }
```

| Key | Values | Meaning |
|---|---|---|
| `defaultAction` | `allow` or `deny` | Applies when no rule matches. Left out, it is `allow` |
| `rules` | A list | Read from the top; the first rule whose method and path both match decides. Put the narrow rules first |
| `method` | An HTTP method, or `"*"` for any (quote it: a bare `*` is not valid YAML here) | Upper or lower case. Left out, it is any method |
| `path` | Starts with `/` | Matched against the path after the service name, without the query string: for `http://127.0.0.1:8585/stripe/v1/customers?limit=3` that is `/v1/customers` |
| `action` | `allow` or `deny` | A rule with anything else is a deny rule |

Path patterns are matched segment by segment:

- `**` stands for any number of whole segments, including none: `/v1/**` matches `/v1`, `/v1/customers` and `/v1/customers/cus_1/sources`.
- `*` inside a segment stands for any characters in that one segment: `/api/v2/tickets/*` matches `/api/v2/tickets/12` and `/api/v2/tickets/12.json`, and not `/api/v2/tickets/12/comments`. `/api/admin.*` matches `/api/admin.users.list`.
- A trailing slash makes no difference.
- A `deny` rule matches without regard to upper and lower case (`/api/v2/Users/me` is refused by the rule above). An `allow` rule matches exactly.

A service with no entry under `policy` has no restriction. A request is refused if any way of reading it is denied: the proxy also evaluates the method named by an `X-HTTP-Method-Override` header or a `_method` query parameter, and the path named by `X-Original-URL`. A refused request never reaches the vault.

`aquaman setup` writes a starting policy for Anthropic and OpenAI when it stores their keys and they have none: it denies their organisation admin endpoints, and `DELETE` for OpenAI. `aquaman policy list` prints what is in force, and `aquaman doctor` reports a rule whose path does not start with `/`. Restart the daemon after editing the file.

`aquaman policy test <service> <METHOD> <path>` answers for one request and says whether a rule or the service's default decided it, for example `ALLOWED by rule: GET /v1/**` or `DENIED (no matching rule, default: deny)`.

## What this does and does not give you

- The app, its dependencies and anything it logs hold a token that is useless off your machine and that the API rejects. The key is never in the app's memory or environment.
- The route token is not a secret from other software on your machine. A local process that reads it can send requests to the routed services, within your policy; it cannot use it to obtain a key. A process running as you can also change the binding itself, so this keeps the key from leaking through the app. It is not a boundary between programs running as you.
- The listener is plain HTTP on a loopback address. aquaman refuses to start it on any other address, and refuses requests addressed to it by any name other than `127.0.0.1` or `localhost`.
- One route token covers every service your projects have routed, and nothing else. Policy rules narrow what it can do on each. A long-running app has to be started again after the daemon restarts, because the token changes.
- The proxy does not forward a header that carries one of its own tokens, as plain text or inside a `Basic` value. It does not look for the token under other encodings, so an app that copies its "key" into another header in some other form sends that local token to the API. The token is of no use there.
- Only HTTP APIs with header or basic authentication, and AWS. For everything else the variable is set to the value, as before.
- It is for your machine. In CI and production leave the URL variable unset and supply the key from that platform's secrets.

Compared with a tool that intercepts all HTTPS traffic through a local certificate authority (fnox `proxy run`, Claude Code's sandbox masking): aquaman needs no certificate in your trust store and the app's TLS to the proxy is not terminated by anything, because the app talks plain HTTP to a local address and the proxy makes the HTTPS call. The cost is that the app has to accept a base URL.
