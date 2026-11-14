#!/usr/bin/env bash
# Live Claude Code check for the aquaman-coder hook. Run before a release and
# after any Claude Code change to hooks or permissions:
#
#   scripts/e2e-claude-code.sh
#
# It drives the real `claude` CLI (headless, your existing login, a few cents
# of Haiku) against an isolated aquaman daemon and a throwaway project, and
# asserts the properties unit tests cannot see because they live in the host:
#
#   1. a wrapped command gets the vault value, and the output is redacted
#   2. the command's exit status survives the wrapper
#   3. a `deny` permission rule on the ORIGINAL command still blocks it inside
#      an aquaman project (broken from Claude Code 2.1.290 until v0.17.1)
#   4. the same for a rule matching the second half of a compound command
#   5. an `ask` rule still asks (headless: the call does not run)
#   6. with `onFailure: "block"` a hook that cannot start blocks the call
#
# Nothing here touches ~/.aquaman, ~/.claude/settings.json or the keychain:
# the daemon uses its own config dir and the encrypted-file backend, and the
# hooks come from a --settings file.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v claude >/dev/null || { echo "claude CLI not found"; exit 1; }
[ -f "$REPO_ROOT/packages/coder/dist/cli/index.js" ] || { echo "run: npm run build"; exit 1; }

# A short path: Unix socket paths are limited to ~100 characters.
WORK="$(mktemp -d /tmp/aqm-cc.XXXXXX)"
WORK="$(cd "$WORK" && pwd -P)"
CANARY="AQM-CANARY-FROM-VAULT-$$"
export AQUAMAN_CONFIG_DIR="$WORK/aq" AQUAMAN_ENCRYPTION_PASSWORD="e2e-claude-code-password-0123456789"
mkdir -p "$AQUAMAN_CONFIG_DIR" "$WORK/proj" "$WORK/bin"
printf '#!/bin/sh\nexec node %s/packages/coder/dist/cli/index.js "$@"\n' "$REPO_ROOT" > "$WORK/bin/aquaman-coder"
printf '#!/bin/sh\nexec node %s/packages/proxy/dist/cli/index.js "$@"\n' "$REPO_ROOT" > "$WORK/bin/aquaman"
chmod +x "$WORK/bin/aquaman-coder" "$WORK/bin/aquaman"
export PATH="$WORK/bin:$PATH"

cleanup() { aquaman stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; echo "    last output: $(tail -c 600 "$WORK/last.out" 2>/dev/null)"; exit 1; }

cat > "$AQUAMAN_CONFIG_DIR/config.yaml" <<EOF
credentials:
  backend: encrypted-file
audit:
  enabled: true
  logDir: $AQUAMAN_CONFIG_DIR/audit
EOF
chmod 600 "$AQUAMAN_CONFIG_DIR/config.yaml"
printf '%s\n' "$CANARY" | aquaman credentials add e2e token >/dev/null
cat > "$AQUAMAN_CONFIG_DIR/projects.yaml" <<EOF
projects:
  e2e:
    paths: ["$WORK/proj"]
    env:
      AQM_CANARY: aquaman://e2e/token
EOF
aquaman daemon > "$WORK/daemon.log" 2>&1 &
for _ in $(seq 1 30); do [ -S "$AQUAMAN_CONFIG_DIR/proxy.sock" ] && break; sleep 0.5; done
[ -S "$AQUAMAN_CONFIG_DIR/proxy.sock" ] || { echo "daemon did not start"; cat "$WORK/daemon.log"; exit 1; }

hooks() { # $1 = hook command, $2 = extra handler fields (JSON fragment)
  cat <<EOF
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$1"$2 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$1" }] }]
  },
  "permissions": { "deny": ["Bash(echo forbidden*)"], "ask": ["Bash(echo askme*)"], "allow": ["Bash(echo hello-live)"] }
}
EOF
}
hooks "aquaman coder hook" "" > "$WORK/settings.json"
hooks "aquaman-missing-binary coder hook" ', "onFailure": "block"' > "$WORK/settings-fail-closed.json"

# Runs one Bash command through Claude Code and prints "<is_error>\t<tool result>".
ask() { # $1 = settings file, $2 = command
  (cd "$WORK/proj" && claude -p "Use the Bash tool exactly once to run this exact command, then report its raw output verbatim and stop. Do not try alternatives if it fails. Command: $2" \
      --settings "$1" --model haiku --output-format stream-json --verbose < /dev/null 2>&1) > "$WORK/last.out" || true
  python3 - "$WORK/last.out" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("type") != "user":
        continue
    for c in d["message"]["content"]:
        if isinstance(c, dict) and c.get("type") == "tool_result":
            content = c.get("content")
            if isinstance(content, list):
                content = " ".join(x.get("text", "") for x in content if isinstance(x, dict))
            print(f"{bool(c.get('is_error'))}\t{content}".replace("\n", "\\n"))
            sys.exit(0)
print("NONE\t")
PY
}

echo "Claude Code $(claude --version)"

out="$(ask "$WORK/settings.json" "sh -c 'echo \"len=\${#AQM_CANARY}\"; printenv AQM_CANARY; exit 7'")"
case "$out" in *"len=${#CANARY}"*) pass "vault value injected into the wrapped command";; *) fail "no injected value: $out";; esac
case "$out" in *"$CANARY"*) fail "the credential reached the transcript";; *"[REDACTED:"*) pass "output redacted";; *) fail "no redaction marker: $out";; esac
case "$out" in *"Exit code 7"*) pass "exit status survives the wrapper";; *) fail "exit status lost: $out";; esac

out="$(ask "$WORK/settings.json" "echo forbidden-one")"
case "$out" in True*"denied"*) pass "deny rule on the original command still blocks it";; *) fail "deny rule bypassed: $out";; esac

out="$(ask "$WORK/settings.json" "echo fine && echo forbidden-two")"
case "$out" in True*"denied"*) pass "deny rule blocks a compound command";; *) fail "deny rule bypassed in a compound command: $out";; esac

out="$(ask "$WORK/settings.json" "echo askme-three")"
case "$out" in True*) case "$out" in *"askme-three\\n"*|*$'\t'"askme-three") fail "ask rule did not stop the command: $out";; *) pass "ask rule still asks";; esac;; *) fail "ask rule bypassed: $out";; esac

out="$(ask "$WORK/settings-fail-closed.json" "echo hello-live")"
case "$out" in True*"blocking because onFailure"*) pass "onFailure: block stops the call when the hook cannot start";; *) fail "hook failure did not block: $out";; esac

echo "All Claude Code live checks passed."
