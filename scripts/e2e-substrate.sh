#!/usr/bin/env bash
# End-to-end: aquaman as the credential provider of a real Agent Substrate
# egress gateway, on a kind cluster this script creates and deletes.
#
#   scripts/e2e-substrate.sh [substrate-git-ref]      (default: v1.0.1)
#
# What it checks. An actor (Substrate's probe fixture, in gVisor) sends a
# request with a placeholder Authorization header to an in-cluster HTTPS origin
# that echoes what it received. The gateway fetches the credential from
# aquaman (FetchSecret, mTLS) on every such request. Checked at the origin:
#   - the stored value arrives in place of the placeholder (HTTPS and HTTP);
#   - a request without the placeholder gets no header;
#   - a reference that is stored but not granted is refused (403), and so is
#     one granted only to another atespace and another actor;
#   - a grant added to the ConfigMap, and one removed, take effect without a
#     restart of the pod (after the kubelet's projection delay, 1 to 2 minutes);
#   - a value stored again is the one the next request carries;
#   - with the provider down the actor gets 503, and 200 again after it is
#     back, with the value from the volume.
# Checked in the pod: `aquaman substrate doctor`, `aquaman audit verify`, an
# audit entry for a served and for a refused fetch that names the actor and
# the reference, and that no stored value is in the audit log, the pod's
# output or the gateway's log. encrypted-file backend only.
#
# Needs: docker (about 4 GB for the cluster; no KVM, the install is gVisor
# only), go (the version Substrate's go.mod names; kind and ko are built from
# Substrate's own tool modules), kubectl, git, node and npm, and the repo
# built (npm run build). Nothing touches ~/.aquaman; kubectl's current
# context is put back at the end.
#
# The driver is scripts/e2e-substrate/*.go, a Go test copied into the
# Substrate checkout because it uses Substrate's internal e2e packages. A
# Substrate ref that renames those helpers breaks the build of the driver,
# not the provider.
#
# Environment:
#   KIND_CLUSTER_NAME    cluster to create and delete (default aqm-substrate-e2e)
#   KIND_REGISTRY_PORT   host port of the local registry (default 5001). The
#                        registry container is always named kind-registry
#                        (Substrate's script); one that is already running on
#                        another port is REPLACED by that script, so name its
#                        port here to share it.
#   KEEP_CLUSTER=1       leave the cluster (and the work directory) in place
set -euo pipefail

SUBSTRATE_REF="${1:-v1.0.1}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-aqm-substrate-e2e}"
export KIND_REGISTRY_PORT="${KIND_REGISTRY_PORT:-5001}"
export KO_DOCKER_REPO="localhost:${KIND_REGISTRY_PORT}"
export ATE_INSTALL_KIND=true
CONTEXT="kind-${KIND_CLUSTER_NAME}"
NS=ate-system
PROVIDER=aquaman-credential-provider
K="kubectl --context $CONTEXT -n $NS"

# Made-up values, different on every run, so a leak into a log is findable.
TAG="$RANDOM$RANDOM"
VALUE="aqm-e2e-value-$TAG"
UNGRANTED_VALUE="aqm-e2e-ungranted-$TAG"
OTHER_VALUE="aqm-e2e-other-$TAG"
LATE_VALUE="aqm-e2e-late-$TAG"
ROTATED_VALUE="aqm-e2e-rotated-$TAG"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/aqm-substrate.XXXXXX")"
PREVIOUS_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
REGISTRY_WAS_THERE=0
docker inspect kind-registry >/dev/null 2>&1 && REGISTRY_WAS_THERE=1
CLUSTER_CREATED=0

cleanup() {
  status=$?
  if [ "${KEEP_CLUSTER:-}" = "1" ]; then
    echo "kept cluster $KIND_CLUSTER_NAME (context $CONTEXT) and $WORK"
    echo "delete with: (cd $WORK/substrate && hack/kind.sh delete cluster --name $KIND_CLUSTER_NAME)"
  else
    if [ "$CLUSTER_CREATED" = "1" ]; then
      ( cd "$WORK/substrate" && hack/kind.sh delete cluster --name "$KIND_CLUSTER_NAME" ) >/dev/null 2>&1 || true
      [ "$REGISTRY_WAS_THERE" = "1" ] || docker rm -f kind-registry >/dev/null 2>&1 || true
    fi
    # Go's module cache is read-only, should a tool have put one here.
    chmod -R u+w "$WORK" 2>/dev/null || true
    rm -rf "$WORK"
  fi
  if [ -n "$PREVIOUS_CONTEXT" ] && kubectl config get-contexts "$PREVIOUS_CONTEXT" >/dev/null 2>&1; then
    kubectl config use-context "$PREVIOUS_CONTEXT" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  if [ "$CLUSTER_CREATED" = "1" ]; then
    echo "--- provider"; $K logs "deploy/$PROVIDER" --tail=30 2>/dev/null || true
    echo "--- gateway (ext-proc)"; $K logs deploy/atenet-egress -c ext-proc --tail=15 2>/dev/null | cut -c1-600 || true
  fi
  for log in "$WORK"/*.log; do [ -f "$log" ] && { echo "--- $(basename "$log")"; tail -25 "$log" | cut -c1-600; }; done
  exit 1
}
pass() { echo "PASS: $*"; }
step() { echo "== $* ($(date -u +%H:%M:%S))"; }

for tool in docker kubectl go git node npm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
done
[ -f "$REPO_ROOT/packages/proxy/dist/cli/index.js" ] || fail "packages/proxy/dist is missing. Run: npm run build"
if kubectl config get-contexts "$CONTEXT" >/dev/null 2>&1; then
  fail "a cluster named $KIND_CLUSTER_NAME already exists; this script creates and deletes its own. Set KIND_CLUSTER_NAME"
fi

# --- Substrate checkout, kind cluster, install -------------------------------
step "Agent Substrate $SUBSTRATE_REF"
# A fetch by ref, so a tag, a branch and a full commit id all work.
{ git init -q "$WORK/substrate" \
  && git -C "$WORK/substrate" remote add origin https://github.com/agent-substrate/substrate \
  && git -C "$WORK/substrate" fetch -q --depth 1 origin "$SUBSTRATE_REF" \
  && git -C "$WORK/substrate" checkout -q FETCH_HEAD; } 2>"$WORK/clone.log" \
  || fail "could not fetch agent-substrate/substrate at $SUBSTRATE_REF"
cd "$WORK/substrate"

step "kind cluster $KIND_CLUSTER_NAME"
CLUSTER_CREATED=1
hack/create-kind-cluster.sh >"$WORK/create-cluster.log" 2>&1 || fail "hack/create-kind-cluster.sh failed"

step "install Substrate (gVisor only) with aquaman registered as a credential provider"
go build -o "$WORK/ate-setup" ./cmd/ate-setup >"$WORK/build-ate-setup.log" 2>&1 || fail "could not build ate-setup"
# The ingress identity is the one Substrate's e2e router client presents.
"$WORK/ate-setup" deploy ate-system --context "$CONTEXT" --sandbox-classes=gvisor \
  --record-dir "$WORK/records" --rollout-timeout 10m \
  --credential-provider="{\"name\":\"aquaman\",\"address\":\"$PROVIDER.$NS.svc:50051\"}" \
  --ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/ate-e2e-router-client/sa/router-client \
  >"$WORK/install.log" 2>&1 || fail "ate-setup deploy ate-system failed"
# The echo origin's certificate is from the cluster's service-DNS authority,
# which the gateway does not trust for upstreams until this test-only patch.
KUBECTL_CONTEXT="$CONTEXT" hack/setup-e2e-egress-tls-kind.sh >"$WORK/egress-tls.log" 2>&1 || fail "hack/setup-e2e-egress-tls-kind.sh failed"
pass "Substrate $SUBSTRATE_REF is installed; the gateway is told to fetch ate-secret://aquaman/... from $PROVIDER.$NS.svc:50051"

# --- the provider, from this checkout ----------------------------------------
step "build and deploy the provider"
mkdir "$WORK/image"
( cd "$REPO_ROOT/packages/proxy" && npm pack --ignore-scripts --silent --pack-destination "$WORK/image" ) >"$WORK/pack.log" 2>&1 || fail "npm pack failed"
TARBALL="$(basename "$(ls "$WORK/image"/aquaman-proxy-*.tgz)")"
IMAGE="localhost:${KIND_REGISTRY_PORT}/$PROVIDER:e2e-$TAG"
# The image's own lockfile pins everything but the daemon, which is this checkout's.
cp "$REPO_ROOT/deploy/substrate/package.json" "$REPO_ROOT/deploy/substrate/package-lock.json" "$WORK/image/"
docker build -q -f "$REPO_ROOT/deploy/substrate/Dockerfile" --build-arg "AQUAMAN_TARBALL=$TARBALL" -t "$IMAGE" "$WORK/image" >"$WORK/image.log" 2>&1 \
  || fail "docker build of deploy/substrate/Dockerfile failed"
docker push -q "$IMAGE" >>"$WORK/image.log" 2>&1 || fail "could not push $IMAGE to the kind registry"

$K create secret generic "$PROVIDER" --from-literal="AQUAMAN_ENCRYPTION_PASSWORD=e2e-substrate-password-$TAG" >/dev/null
sed "s#^\\( *image: \\).*$PROVIDER.*#\\1$IMAGE#" "$REPO_ROOT/deploy/substrate/aquaman-credential-provider.yaml" > "$WORK/provider.yaml"
grep -q "image: $IMAGE" "$WORK/provider.yaml" || fail "the image line of deploy/substrate/aquaman-credential-provider.yaml was not found"
$K apply -f "$WORK/provider.yaml" >"$WORK/apply.log" 2>&1 || fail "kubectl apply of the provider manifest failed"
$K rollout status "deploy/$PROVIDER" --timeout=180s >>"$WORK/apply.log" 2>&1 || fail "the provider pod did not become ready"
pass "provider pod is ready (image built from this checkout, manifest as shipped)"

store() { printf '%s' "$2" | $K exec -i "deploy/$PROVIDER" -- aquaman credentials add substrate-demo "$1" --backend encrypted-file >/dev/null; }
store api_token "$VALUE"; store ungranted_token "$UNGRANTED_VALUE"; store other_token "$OTHER_VALUE"; store late_token "$LATE_VALUE"
$K exec "deploy/$PROVIDER" -- aquaman substrate doctor >"$WORK/doctor-before.log" 2>&1 || fail "aquaman substrate doctor failed in the pod"
pass "four values stored in the pod's encrypted-file vault; aquaman substrate doctor passes"

# --- the driver ---------------------------------------------------------------
step "drive an actor through the gateway (this takes about five minutes)"
mkdir -p internal/e2e/suites/aquamanprovider
cp "$REPO_ROOT"/scripts/e2e-substrate/*.go internal/e2e/suites/aquamanprovider/
driver=0
# Without CI in the environment: Substrate's runner then insists on a JUnit file and
# switches to another test runner, for its own pipeline's bookkeeping. This script
# counts the driver's checks itself, below.
env -u CI AQM_VALUE="$VALUE" AQM_LATE_VALUE="$LATE_VALUE" AQM_ROTATED="$ROTATED_VALUE" AQM_NAMESPACE="$NS" \
  hack/run-e2e-kind.sh ./internal/e2e/suites/aquamanprovider -v -count=1 -timeout 30m -args --no-color >"$WORK/driver.log" 2>&1 || driver=$?
grep -o 'AQM CHECK .*' "$WORK/driver.log" | sed -e 's/^AQM CHECK \([^:]*\): PASS: /PASS: \1: /' -e 's/^AQM CHECK \([^:]*\): FAIL: /FAIL: \1: /' || true
[ "$driver" = "0" ] || fail "the driver failed (exit $driver)"
[ "$(grep -c 'AQM CHECK .*: PASS' "$WORK/driver.log")" -ge 14 ] || fail "the driver ran fewer checks than it has"

# --- what the pod recorded -----------------------------------------------------
step "audit log and leaks"
$K exec "deploy/$PROVIDER" -- aquaman substrate doctor >"$WORK/doctor.log" 2>&1 || fail "aquaman substrate doctor failed after the run"
pass "aquaman substrate doctor passes after the run"
$K exec "deploy/$PROVIDER" -- aquaman audit verify >"$WORK/audit-verify.log" 2>&1 || fail "aquaman audit verify failed in the pod"
pass "aquaman audit verify: $(grep -m1 'Entries' "$WORK/audit-verify.log" | tr -s ' ')"
$K exec "deploy/$PROVIDER" -- cat /aqm/audit/current.jsonl >"$WORK/audit.jsonl" 2>/dev/null || fail "could not read the audit log"
node -e '
  const entries = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const from = (e) => /^actor\/ate-e2e-probe-aqm\/probe-aqm$/.test(e.sessionId) && e.agentId === "substrate";
  const served = entries.find((e) => from(e) && e.data.success === true && e.data.note === "aquaman://substrate-demo/api_token");
  const refused = entries.find((e) => from(e) && e.data.success === false && e.data.note === "aquaman://substrate-demo/ungranted_token");
  if (!served) { console.error("no entry for a served fetch of api_token by the actor"); process.exit(1); }
  if (!refused) { console.error("no entry for the refused fetch of ungranted_token by the actor"); process.exit(1); }
' "$WORK/audit.jsonl" || fail "the audit log does not name the actor and the reference"
pass "audit entries carry sessionId actor/<atespace>/<actor>, agentId substrate and the reference, served and refused"

$K logs "deploy/$PROVIDER" --tail=-1 >"$WORK/pod-output.txt" 2>&1 || true
$K logs deploy/atenet-egress -c ext-proc --tail=-1 >"$WORK/gateway-extproc.txt" 2>&1 || true
$K logs deploy/atenet-egress -c envoy --tail=-1 >"$WORK/gateway-envoy.txt" 2>&1 || true
for value in "$VALUE" "$UNGRANTED_VALUE" "$OTHER_VALUE" "$LATE_VALUE" "$ROTATED_VALUE"; do
  if grep -l -F "$value" "$WORK/audit.jsonl" "$WORK/pod-output.txt" "$WORK/gateway-extproc.txt" "$WORK/gateway-envoy.txt" "$WORK/doctor.log" 2>/dev/null; then
    fail "a stored value is in the file named above"
  fi
done
[ -s "$WORK/gateway-extproc.txt" ] || fail "the gateway's log could not be read, so the leak check saw nothing"
pass "no stored value in the audit log, the pod's output or the gateway's logs"

echo "ALL PASSED (Agent Substrate $SUBSTRATE_REF)"
