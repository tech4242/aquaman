#!/usr/bin/env bash
# End-to-end: `aquaman hermes setup` against a real Hermes program.
#
#   scripts/e2e-hermes-setup.sh <path-to-hermes> stored|manual
#
# `stored`: a Hermes whose `hermes config set` keeps every setting in the
# profile's .env (0.21.4 or later). Setup must store the six settings through
# it, for the default profile and for a named one, and leave a real provider
# key alone unless told otherwise.
# `manual`: an earlier Hermes, where part of the settings would land in
# config.yaml. Setup must run nothing and say what to add.
#
# Needs node and the repo built (npm run build). Everything runs in a throwaway
# home: nothing touches ~/.hermes or ~/.aquaman.
set -euo pipefail

HERMES_BIN="${1:?path to the hermes program}"
EXPECT="${2:?stored or manual}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_ROOT/packages/proxy/dist/cli/index.js"
PORT=9951
BASE="http://127.0.0.1:$PORT"

WORK="$(mktemp -d /tmp/aqh.XXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/cfg"
printf 'credentials:\n  backend: encrypted-file\n  proxiedServices:\n    - anthropic\n    - openai\n' > "$WORK/cfg/config.yaml"

HERMES_HOME_DIR="$WORK/home/.hermes"
CLEAN_PATH="$(dirname "$HERMES_BIN"):$(dirname "$(command -v node)"):/usr/bin:/bin"
in_home() { env -i PATH="$CLEAN_PATH" HOME="$WORK/home" HERMES_HOME="$HERMES_HOME_DIR" "$@"; }
aquaman() { in_home AQUAMAN_CONFIG_DIR="$WORK/cfg" AQUAMAN_ENCRYPTION_PASSWORD=e2e-password NO_COLOR=1 node "$CLI" "$@"; }
hermes() { in_home "$HERMES_BIN" "$@"; }

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
has_line() { grep -qxF "$2" "$1" || fail "$1 has no line: $2"; }

version="$(hermes --version)"
echo "${version%%$'\n'*}"

if [ "$EXPECT" = "manual" ]; then
  out="$(aquaman hermes setup --port "$PORT")" || fail "setup exited non-zero: $out"
  echo "$out" | grep -q 'so nothing was run' || fail "setup did not say it ran nothing: $out"
  [ ! -e "$HERMES_HOME_DIR/.env" ] || ! grep -q 'AQUAMAN_\|_BASE_URL' "$HERMES_HOME_DIR/.env" || fail ".env was written"
  [ ! -e "$HERMES_HOME_DIR/config.yaml" ] || ! grep -q 'AQUAMAN_\|_BASE_URL' "$HERMES_HOME_DIR/config.yaml" || fail "config.yaml was written"
  pass "an earlier Hermes: nothing run, nothing stored"
  exit 0
fi

# --- default profile -----------------------------------------------------
out="$(aquaman hermes setup --port "$PORT")" || fail "setup exited non-zero: $out"
echo "$out" | grep -q 'Stored 6 settings with `hermes config set`' || fail "setup did not report six settings: $out"
TOKEN="$(sed -n 's/^ *token: *//p' "$WORK/cfg/config.yaml")"
[ -n "$TOKEN" ] || fail "no loopback token in aquaman's config"
ENV_FILE="$(hermes config env-path | tail -1)"
[ "$ENV_FILE" = "$HERMES_HOME_DIR/.env" ] || fail "unexpected env path $ENV_FILE"
has_line "$ENV_FILE" "AQUAMAN_LOOPBACK_URL=$BASE"
has_line "$ENV_FILE" "AQUAMAN_LOOPBACK_TOKEN=$TOKEN"
has_line "$ENV_FILE" "ANTHROPIC_BASE_URL=$BASE/anthropic"
has_line "$ENV_FILE" "ANTHROPIC_API_KEY=$TOKEN"
has_line "$ENV_FILE" "OPENAI_BASE_URL=$BASE/openai/v1"
has_line "$ENV_FILE" "OPENAI_API_KEY=$TOKEN"
[ ! -e "$HERMES_HOME_DIR/config.yaml" ] || ! grep -q 'AQUAMAN_\|_BASE_URL' "$HERMES_HOME_DIR/config.yaml" || fail "a setting landed in config.yaml"
echo "$out" | grep -qF "$TOKEN" && fail "setup printed the token"
pass "default profile: six settings in .env, none in config.yaml"

# Hermes keeps the base URL with the key in its credential pool, so the key
# has to be stored after the base URL.
grep -qF "\"base_url\": \"$BASE/anthropic\"" "$HERMES_HOME_DIR/auth.json" || fail "Hermes's credential pool does not point anthropic at the proxy"
pass "Hermes's credential pool has the proxy as the anthropic base URL"

before="$(cat "$ENV_FILE")"
aquaman hermes setup > /dev/null || fail "second run exited non-zero"
[ "$(cat "$ENV_FILE")" = "$before" ] || fail "a second run changed the file"
pass "a second run changes nothing"

# doctor exits 1 here: no daemon runs and no credential is stored. Only its line about the file is read.
doctor="$(aquaman hermes doctor || true)"
echo "$doctor" | grep -q 'Hermes .env points at the proxy' || fail "doctor does not see the settings: $doctor"
pass "doctor reads the settings from the file Hermes wrote"

# --- named profile -------------------------------------------------------
hermes profile create work > /dev/null
out="$(aquaman hermes setup --profile work)" || fail "setup --profile exited non-zero: $out"
WORK_ENV="$HERMES_HOME_DIR/profiles/work/.env"
has_line "$WORK_ENV" "ANTHROPIC_BASE_URL=$BASE/anthropic"
has_line "$WORK_ENV" "ANTHROPIC_API_KEY=$TOKEN"
[ "$(cat "$ENV_FILE")" = "$before" ] || fail "setting up a named profile changed the default one"
# Captured first: `grep -q` closes the pipe at its first match, while the CLI is still printing.
status="$(aquaman hermes status --profile work)"
echo "$status" | grep -q 'Hermes .env: *wired' || fail "status does not see the named profile: $status"
pass "named profile: stored in profiles/work/.env, default profile untouched"

out="$(aquaman hermes setup --profile nosuch 2>&1)" && fail "setup of a missing profile succeeded"
echo "$out" | grep -q 'does not exist' || fail "no reason given for a missing profile: $out"
pass "a profile that does not exist is refused with Hermes's own message"

# --- a real key already in the file --------------------------------------
hermes profile create keys > /dev/null
hermes -p keys config set ANTHROPIC_API_KEY a-key-the-person-put-here > /dev/null
KEYS_ENV="$HERMES_HOME_DIR/profiles/keys/.env"
out="$(aquaman hermes setup --profile keys 2>&1)" && fail "setup replaced a real key without being told to"
echo "$out" | grep -q 'would replace it' || fail "no reason given: $out"
has_line "$KEYS_ENV" "ANTHROPIC_API_KEY=a-key-the-person-put-here"
aquaman hermes setup --profile keys --replace-keys > /dev/null || fail "--replace-keys exited non-zero"
has_line "$KEYS_ENV" "ANTHROPIC_API_KEY=$TOKEN"
pass "a real key is left alone until --replace-keys"

echo "ALL PASSED"
