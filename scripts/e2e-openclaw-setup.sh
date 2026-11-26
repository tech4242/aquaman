#!/usr/bin/env bash
# End-to-end: `aquaman openclaw setup` against a real `openclaw` program.
#
#   scripts/e2e-openclaw-setup.sh <path-to-openclaw>
#
# aquaman does not write openclaw.json: it hands OpenClaw one merge patch
# (`openclaw config patch --stdin`). This checks, with the real program, that
# the patch is accepted and what the file then holds; that a provider whose
# baseUrl is the user's own gets no key reference; that the resolver gives the
# loopback token only for a reference whose endpoint is the proxy; that a
# second run changes nothing; that a named profile and a read-only config are
# respected; and that the migration's cleanup goes the same way.
#
# Needs node and the repo built (npm run build). Everything runs in a throwaway
# home: nothing touches ~/.openclaw or ~/.aquaman, and no gateway is started.
set -euo pipefail

OPENCLAW_BIN="${1:?path to the openclaw program}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_ROOT/packages/proxy/dist/cli/index.js"
RESOLVER="$REPO_ROOT/packages/plugin/dist/secrets-resolver.mjs"

WORK="$(mktemp -d /tmp/aqo.XXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/cfg"

NODE_DIR="$(dirname "$(command -v node)")"
OC_DIR="$(cd "$(dirname "$OPENCLAW_BIN")" && pwd)"
BASE_ENV=(PATH="$OC_DIR:$NODE_DIR:/usr/bin:/bin" HOME="$WORK/home" NO_COLOR=1)
in_home() { env -i "${BASE_ENV[@]}" "$@"; }
# aquaman [NAME=value ...] <arguments>: leading assignments go into the environment.
aquaman() {
  local extra=()
  while [[ "${1:-}" == *=* ]]; do extra+=("$1"); shift; done
  in_home AQUAMAN_CONFIG_DIR="$WORK/cfg" AQUAMAN_ENCRYPTION_PASSWORD=e2e-password ${extra[@]+"${extra[@]}"} node "$CLI" "$@"
}
KEYS=(ANTHROPIC_API_KEY=e2e-anthropic-key OPENAI_API_KEY=e2e-openai-key)
SETUP=(openclaw setup --backend encrypted-file --non-interactive)
openclaw() { in_home "$OPENCLAW_BIN" "$@"; }

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
# One value out of a JSON file: json <file> <js expression over `c`>
json() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=eval(process.argv[2]); console.log(typeof v==="string"?v:JSON.stringify(v))' "$1" "$2"; }

version="$(openclaw --version 2>/dev/null | tail -1)"
echo "$version"

OC_JSON="$WORK/home/.openclaw/openclaw.json"
ANTHROPIC_REF='{"source":"exec","provider":"aquaman","id":"anthropic/api_key"}'

# A provider the person already pointed at their own gateway, before aquaman.
echo '{"models":{"providers":{"openai":{"baseUrl":"https://llm-gateway.example.com/v1","models":[]}}}}' \
  | openclaw config patch --stdin > /dev/null || fail "could not prepare the config"

# --- setup ---------------------------------------------------------------
out="$(aquaman "${KEYS[@]}" "${SETUP[@]}" 2>&1)" || fail "setup exited non-zero: $out"
echo "$out" | grep -qF 'OpenClaw config changed through `openclaw config patch`' || fail "setup did not go through openclaw config patch: $out"

TOKEN="$(sed -n 's/^ *token: *//p' "$WORK/cfg/config.yaml")"
[ -n "$TOKEN" ] || fail "no loopback token in aquaman's config"
[ "$(json "$OC_JSON" 'c.models.providers.anthropic.baseUrl')" = "http://127.0.0.1:8585/anthropic" ] || fail "anthropic is not routed"
[ "$(json "$OC_JSON" 'c.models.providers.anthropic.apiKey')" = "$ANTHROPIC_REF" ] || fail "anthropic has no key reference"
[ "$(json "$OC_JSON" 'c.secrets.providers.aquaman.pluginIntegration.pluginId')" = "aquaman-plugin" ] || fail "no secrets provider"
[ "$(json "$OC_JSON" 'c.plugins.entries["aquaman-plugin"].enabled')" = "true" ] || fail "plugin entry not enabled"
pass "one patch accepted: plugin entry, secrets provider, anthropic routed with a key reference"

[ "$(json "$OC_JSON" 'c.models.providers.openai.baseUrl')" = "https://llm-gateway.example.com/v1" ] || fail "the user's baseUrl was changed"
[ "$(json "$OC_JSON" 'c.models.providers.openai.apiKey === undefined')" = "true" ] || fail "a key reference was written beside the user's baseUrl"
pass "a provider with the user's own baseUrl got no key reference"

grep -q "aqm_lb_" "$OC_JSON" && fail "the loopback token is in openclaw.json"
echo "$out" | grep -qF "$TOKEN" && fail "setup printed the loopback token"
# Through node: `stat` takes different flags on Linux and macOS.
mode="$(node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$OC_JSON")"
[ "$mode" = "600" ] || fail "openclaw.json is not owner-only (mode $mode)"
pass "no token in openclaw.json or in the output; the file is owner-only"

openclaw config validate > /dev/null 2>&1 || fail "OpenClaw does not accept the resulting config"
pass "openclaw config validate accepts the result"

# --- the resolver, asked the way the gateway asks it -----------------------
answer="$(echo '{"protocolVersion":1,"provider":"aquaman","ids":["anthropic/api_key","openai/api_key"]}' \
  | env -i HOME="$WORK/home" AQUAMAN_CONFIG_DIR="$WORK/cfg" "$NODE_DIR/node" "$RESOLVER")"
[ "$(node -e 'console.log(JSON.parse(process.argv[1]).values["anthropic/api_key"])' "$answer")" = "$TOKEN" ] || fail "the routed provider did not get the token: $answer"
[ "$(node -e 'console.log(JSON.parse(process.argv[1]).values["openai/api_key"])' "$answer")" = "aquaman-proxy-managed" ] || fail "a provider that is not routed got the token: $answer"
pass "the resolver gives the token for the routed provider and the placeholder for the other"

# --- second run ------------------------------------------------------------
before="$(cat "$OC_JSON")"
out="$(aquaman "${KEYS[@]}" "${SETUP[@]}" 2>&1)" || fail "second run exited non-zero: $out"
echo "$out" | grep -qF 'OpenClaw config already holds these settings' || fail "second run did not find the settings: $out"
[ "$(cat "$OC_JSON")" = "$before" ] || fail "a second run changed the file"
pass "a second run changes nothing"

# --- a reference an earlier version left beside the user's baseUrl ---------
echo '{"models":{"providers":{"openai":{"apiKey":{"source":"exec","provider":"aquaman","id":"openai/api_key"}}}}}' \
  | openclaw config patch --stdin > /dev/null || fail "could not prepare the stale reference"
aquaman "${KEYS[@]}" "${SETUP[@]}" > /dev/null 2>&1 || fail "setup over a stale reference exited non-zero"
[ "$(json "$OC_JSON" 'c.models.providers.openai.apiKey === undefined')" = "true" ] || fail "the stale reference is still there"
[ "$(json "$OC_JSON" 'c.models.providers.openai.baseUrl')" = "https://llm-gateway.example.com/v1" ] || fail "the user's baseUrl was changed"
pass "a key reference beside the user's baseUrl is taken back (a null in the patch deletes it)"

# --- read-only -------------------------------------------------------------
echo '{"models":{"providers":{"anthropic":{"baseUrl":null,"apiKey":null}}}}' | openclaw config patch --stdin > /dev/null
before="$(cat "$OC_JSON")"
out="$(aquaman "${KEYS[@]}" OPENCLAW_CONFIG_READONLY=1 "${SETUP[@]}" 2>&1)" || fail "read-only run exited non-zero: $out"
echo "$out" | grep -qF 'OPENCLAW_CONFIG_READONLY=1 marks the config as managed elsewhere' || fail "read-only was not respected: $out"
[ "$(cat "$OC_JSON")" = "$before" ] || fail "a read-only config was changed"
[ -f "$WORK/cfg/openclaw-setup.patch.json" ] || fail "no patch was saved"
grep -q "aqm_lb_" "$WORK/cfg/openclaw-setup.patch.json" && fail "the saved patch holds the token"
pass "a read-only config is left alone and the patch is saved, without a secret in it"

# The saved patch is one OpenClaw takes as it is.
openclaw config patch --file "$WORK/cfg/openclaw-setup.patch.json" > /dev/null 2>&1 || fail "OpenClaw does not accept the saved patch"
[ "$(json "$OC_JSON" 'c.models.providers.anthropic.baseUrl')" = "http://127.0.0.1:8585/anthropic" ] || fail "the saved patch did not route anthropic"
pass "the saved patch applies with openclaw config patch --file"

# --- a named profile -------------------------------------------------------
out="$(aquaman "${KEYS[@]}" "${SETUP[@]}" --profile work 2>&1)" || fail "setup --profile exited non-zero: $out"
PROFILE_JSON="$WORK/home/.openclaw-work/openclaw.json"
[ "$(json "$PROFILE_JSON" 'c.models.providers.anthropic.baseUrl')" = "http://127.0.0.1:8585/anthropic" ] || fail "the profile was not set up"
[ "$(openclaw --profile work config get models.providers.anthropic.baseUrl 2>/dev/null | tail -1)" = "http://127.0.0.1:8585/anthropic" ] || fail "openclaw --profile work does not see the setting"
pass "--profile work is set up under ~/.openclaw-work, and OpenClaw reads it there"

# --- migration cleanup, then the channel it frees up ------------------------
echo '{"channels":{"telegram":{"enabled":false,"botToken":"123456:e2e-plain-telegram-token"}}}' \
  | openclaw config patch --stdin > /dev/null || fail "could not prepare a plaintext channel token"
out="$(aquaman openclaw migrate --auto --cleanup 2>&1)" || fail "migrate --cleanup exited non-zero: $out"
[ "$(json "$OC_JSON" 'c.channels.telegram.botToken')" = "aquaman-proxy-managed" ] || fail "the plaintext token is still in openclaw.json: $out"
grep -q "e2e-plain-telegram-token" "$OC_JSON" && fail "the plaintext token is still in openclaw.json"
pass "migrate --cleanup replaces a plaintext token through openclaw config patch"

out="$(aquaman "${KEYS[@]}" "${SETUP[@]}" 2>&1)" || fail "setup after migration exited non-zero: $out"
[ "$(json "$OC_JSON" 'c.channels.telegram.apiRoot')" = "http://127.0.0.1:8585/telegram" ] || fail "telegram is not routed: $out"
[ "$(json "$OC_JSON" 'c.channels.telegram.botToken')" = '{"source":"exec","provider":"aquaman","id":"telegram/bot_token"}' ] || fail "telegram's token is not a reference"
grep -q "aqm_lb_" "$OC_JSON" && fail "the loopback token is in openclaw.json"
openclaw config validate > /dev/null 2>&1 || fail "OpenClaw does not accept the config with the channel reference"
pass "telegram is routed with its token as a reference, and the config validates"

echo "ALL PASSED"
