#!/usr/bin/env bash
# End-to-end: aquaman daemon as the credential driver of a real OpenShell gateway.
#
#   scripts/e2e-openshell.sh [openshell-version]      (default: latest release)
#
# Needs Docker (on macOS: Docker Desktop with a Landlock-enabled kernel, 4.93.0+
# verified, and host networking on), gh, node, and the repo built (npm run build).
# Everything runs in a throwaway directory; nothing touches ~/.aquaman.
set -euo pipefail

VERSION="${1:-}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AQUAMAN="node $REPO_ROOT/packages/proxy/dist/cli/index.js"
CANARY="AQM-OPENSHELL-E2E-CANARY-$RANDOM$RANDOM"
PORT="${OPENSHELL_E2E_PORT:-17690}"

# Short base dir: Unix socket paths are capped at ~104 bytes on macOS.
WORK="$(mktemp -d /tmp/aqe.XXXX)"
GATEWAY_PID=""; DAEMON_PID=""
cleanup() {
  [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null || true
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  sleep 1
  if [ "${KEEP_WORK:-}" != "1" ]; then rm -rf "$WORK"; else echo "kept $WORK"; fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; echo "--- gateway log"; tail -30 "$WORK/gateway.log" 2>/dev/null || true; echo "--- daemon log"; tail -30 "$WORK/daemon.log" 2>/dev/null || true; exit 1; }
pass() { echo "PASS: $*"; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) CLI_ASSET=openshell-aarch64-apple-darwin.tar.gz; GW_ASSET=openshell-gateway-aarch64-apple-darwin.tar.gz ;;
  Linux-x86_64) CLI_ASSET=openshell-x86_64-unknown-linux-musl.tar.gz; GW_ASSET=openshell-gateway-x86_64-unknown-linux-gnu.tar.gz ;;
  Linux-aarch64) CLI_ASSET=openshell-aarch64-unknown-linux-musl.tar.gz; GW_ASSET=openshell-gateway-aarch64-unknown-linux-gnu.tar.gz ;;
  *) fail "unsupported platform $(uname -s)-$(uname -m)" ;;
esac

# --- OpenShell binaries (checksum-verified) ---
if [ -z "$VERSION" ]; then
  VERSION="$(gh release list -R NVIDIA/OpenShell --exclude-pre-releases --limit 1 --json tagName --jq '.[0].tagName')"
fi
echo "OpenShell $VERSION on $(uname -s)-$(uname -m)"
mkdir -p "$WORK/dl" "$WORK/bin"
gh release download "$VERSION" -R NVIDIA/OpenShell -D "$WORK/dl" \
  -p "$CLI_ASSET" -p "$GW_ASSET" -p 'openshell-checksums-sha256.txt' -p 'openshell-gateway-checksums-sha256.txt'
( cd "$WORK/dl" && grep -h -E " (\*)?($CLI_ASSET|$GW_ASSET)\$" openshell-checksums-sha256.txt openshell-gateway-checksums-sha256.txt | shasum -a 256 -c - ) \
  || fail "checksum mismatch"
tar -xzf "$WORK/dl/$CLI_ASSET" -C "$WORK/bin"
tar -xzf "$WORK/dl/$GW_ASSET" -C "$WORK/bin"
OS="env HOME=$WORK/home $WORK/bin/openshell --gateway-endpoint http://127.0.0.1:$PORT"
mkdir -p "$WORK/home"

# --- aquaman: isolated config, encrypted-file vault, one canary, driver on ---
export AQUAMAN_CONFIG_DIR="$WORK/aq" AQUAMAN_ENCRYPTION_PASSWORD="e2e-openshell-password-0123456789"
mkdir -p "$AQUAMAN_CONFIG_DIR/audit"
cat > "$AQUAMAN_CONFIG_DIR/config.yaml" <<EOF
credentials:
  backend: encrypted-file
  proxiedServices: [anthropic]
audit:
  enabled: true
  logDir: $AQUAMAN_CONFIG_DIR/audit
EOF
printf '%s\n' "$CANARY" | $AQUAMAN credentials add e2e echo_key >/dev/null
$AQUAMAN broker allow aquaman://e2e/echo_key >/dev/null
$AQUAMAN openshell setup >/dev/null
$AQUAMAN daemon > "$WORK/daemon.log" 2>&1 & DAEMON_PID=$!
for _ in $(seq 1 30); do [ -S "$AQUAMAN_CONFIG_DIR/openshell.sock" ] && break; sleep 0.5; done
[ -S "$AQUAMAN_CONFIG_DIR/openshell.sock" ] || fail "driver socket never appeared"
$AQUAMAN openshell doctor >/dev/null || fail "aquaman openshell doctor failed"
pass "aquaman daemon serves the driver; doctor green"

# --- OpenShell gateway pointed at the driver ---
mkdir -p "$WORK/jwt" "$WORK/gw"
openssl genpkey -algorithm ed25519 -out "$WORK/jwt/signing.pem" 2>/dev/null
openssl pkey -in "$WORK/jwt/signing.pem" -pubout -out "$WORK/jwt/public.pem"
echo "aqm-e2e" > "$WORK/jwt/kid"
cat > "$WORK/gateway.toml" <<EOF
[openshell]
version = 2

[openshell.gateway]
compute_driver = "docker"
credential_drivers = ["aquaman"]

[openshell.gateway.credential_storage]
key_encryption_key_path = "$WORK/gw/kek.bin"

[openshell.gateway.gateway_jwt]
signing_key_path = "$WORK/jwt/signing.pem"
public_key_path  = "$WORK/jwt/public.pem"
kid_path         = "$WORK/jwt/kid"
gateway_id       = "aqm-e2e"

[openshell.gateway.auth]
allow_unauthenticated_users = true

[openshell.credential_drivers.aquaman]
transport = "uds"
socket_path = "$AQUAMAN_CONFIG_DIR/openshell.sock"

[openshell.drivers.docker]
EOF
$AQUAMAN openshell doctor --gateway-config "$WORK/gateway.toml" >/dev/null || fail "doctor rejected the gateway config"
HOME="$WORK/home" "$WORK/bin/openshell-gateway" --config "$WORK/gateway.toml" --disable-tls --port "$PORT" \
  --db-url "sqlite://$WORK/gw/gw.db?mode=rwc" > "$WORK/gateway.log" 2>&1 & GATEWAY_PID=$!
for _ in $(seq 1 40); do $OS status >/dev/null 2>&1 && break; sleep 0.5; done
$OS status >/dev/null 2>&1 || fail "gateway did not come up"
pass "gateway $VERSION negotiated the aquaman driver"

# --- provider by reference; undeclared ref refused ---
cat > "$WORK/profile.yaml" <<'EOF'
id: aqm-e2e-echo
display_name: aquaman e2e echo
description: Fake key echoed back by httpbin.org/headers
category: other
credentials:
  - name: api_key
    description: Fake canary
    env_vars: [AQM_ECHO_KEY]
    required: true
    auth_style: header
    header_name: x-aqm-key
endpoints:
  - host: httpbin.org
    port: 443
    protocol: rest
    access: read-only
    enforcement: enforce
binaries: [/usr/bin/curl, /usr/local/bin/curl]
EOF
$OS profile import -f "$WORK/profile.yaml" --global >/dev/null
$OS provider create --name e2e-ref --type aqm-e2e-echo --credential AQM_ECHO_KEY=aquaman://e2e/echo_key >/dev/null \
  || fail "provider create by reference"
if $OS provider create --name e2e-bad --type aqm-e2e-echo --credential AQM_ECHO_KEY=aquaman://e2e/undeclared >"$WORK/bad.out" 2>&1; then
  fail "undeclared reference was accepted"
fi
grep -q "aquaman broker allow aquaman://e2e/undeclared" "$WORK/bad.out" || fail "refusal did not carry the fix"
pass "reference accepted; undeclared reference refused with the fix"

# --- sandbox: placeholder inside, real value at the upstream ---
$OS sandbox create --name e2e --from curlimages/curl:latest --provider e2e-ref --no-tty --no-keep --no-auto-providers -- \
  sh -c 'echo "ENV=$AQM_ECHO_KEY"; curl -sS -H "x-aqm-key: $AQM_ECHO_KEY" https://httpbin.org/headers' > "$WORK/sandbox.out" 2>&1 \
  || fail "sandbox run: $(tail -5 "$WORK/sandbox.out")"
grep -q "ENV=openshell:resolve:env:" "$WORK/sandbox.out" || fail "sandbox did not see a placeholder"
grep -q "$CANARY" "$WORK/sandbox.out" && grep -q "ENV=$CANARY" "$WORK/sandbox.out" && fail "real value visible in the sandbox env"
grep -qi "\"X-Aqm-Key\": \"$CANARY\"" "$WORK/sandbox.out" || fail "upstream did not receive the vault value"
pass "sandbox saw only the placeholder; upstream received the vault value"

# --- audit: a read for e2e, no value ---
sleep 1
grep -rq '"service":"e2e"' "$AQUAMAN_CONFIG_DIR/audit" || fail "no audit entry for the resolve"
grep -rq "$CANARY" "$AQUAMAN_CONFIG_DIR/audit" && fail "canary value written to the audit log"
grep -rq "$CANARY" "$WORK/daemon.log" && fail "canary value written to the daemon log"
pass "resolve audited without the value"

echo "ALL PASSED (OpenShell $VERSION)"
