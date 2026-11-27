// Driver for scripts/e2e-substrate.sh. It is not part of Agent Substrate:
// the script copies this directory into a Substrate checkout as
// internal/e2e/suites/aquamanprovider and runs it with Substrate's own
// hack/run-e2e-kind.sh, because the actor, the echo origin, the egress policy
// and the router client all come from Substrate's internal e2e packages.
//
// What it does: one actor (Substrate's probe fixture) fetches an in-cluster
// HTTPS origin that echoes the headers it received. The actor's EgressPolicy
// replaces its placeholder Authorization header with a credential named by an
// ate-secret://aquaman/... URI, which the egress gateway fetches from the
// aquaman provider on every request. Each check is one "AQM CHECK" line.
//
// The provider must already be deployed (deploy/substrate/) with the four
// substrate-demo values stored; the grants are written by this test.
//
// Environment:
//
//	AQM_VALUE        value stored as substrate-demo/api_token (required)
//	AQM_LATE_VALUE   value stored as substrate-demo/late_token (required)
//	AQM_ROTATED      value the test stores over api_token (required)
//	AQM_NAMESPACE    namespace of the provider (default ate-system)
//	AQM_HOLD_DIR     if set, after the checks the test keeps the actor and
//	                 repeats one fetch whenever a file "next" appears in the
//	                 directory, until a file "done" appears (for work by hand)
package aquamanprovider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.ate.dev/substrate/api/ateapi/v1"
	"go.ate.dev/substrate/internal/e2e"
	"go.ate.dev/substrate/internal/resources"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"sigs.k8s.io/yaml"
)

const (
	provider      = "aquaman-credential-provider"
	probeTemplate = "probe"
	actorName     = "probe-aqm"
	placeholder   = "Bearer actor-placeholder"

	grantedRef   = "aquaman://substrate-demo/api_token"
	ungrantedRef = "aquaman://substrate-demo/ungranted_token" // stored, granted to nobody
	otherRef     = "aquaman://substrate-demo/other_token"     // stored, granted to another atespace
	lateRef      = "aquaman://substrate-demo/late_token"      // stored, granted during the test

	ungrantedHost = "ungranted.aqm.invalid"
	otherHost     = "other-atespace.aqm.invalid"
	// The late reference is injected at the echo origin, in a header of its
	// own, because a served request has to reach an origin the gateway trusts.
	lateHeader = "X-Late-Token"
)

func secretURI(ref string) string {
	return "ate-secret://aquaman/" + strings.TrimPrefix(ref, "aquaman://")
}

var echoServer = e2e.ServiceDNSTLS(e2e.ServerPod{
	Name:       "echo",
	ImportPath: "go.ate.dev/substrate/internal/e2e/fixtures/testserver",
	Args:       []string{"http"},
})

type fetchResponse struct {
	Status string `json:"status"`
	Error  string `json:"error"`
	Body   string `json:"body"`
}

// header is a request header as the echo origin received it, "" when absent.
func (r fetchResponse) header(name string) string {
	var echoed struct {
		Headers map[string]string `json:"headers"`
	}
	_ = json.Unmarshal([]byte(r.Body), &echoed)
	return echoed.Headers[name]
}

func (r fetchResponse) auth() string { return r.header("Authorization") }

func namespace() string {
	if ns := os.Getenv("AQM_NAMESPACE"); ns != "" {
		return ns
	}
	return "ate-system"
}

func kubectl(t *testing.T, stdin string, args ...string) string {
	t.Helper()
	full := []string{"-n", namespace()}
	if e2e.KubeContext != "" {
		full = append([]string{"--context=" + e2e.KubeContext}, full...)
	}
	cmd := exec.Command("kubectl", append(full, args...)...)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		t.Fatalf("kubectl %s: %v: %s", strings.Join(args, " "), err, errOut.String())
	}
	return out.String()
}

// setGrants rewrites substrate.provider.grants in the provider's ConfigMap and
// leaves the rest of config.yaml as deployed. The pod is not restarted.
func setGrants(t *testing.T, grants map[string][]string) {
	t.Helper()
	raw := kubectl(t, "", "get", "configmap", provider, "-o", "json")
	var cm struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &cm); err != nil {
		t.Fatalf("reading the provider ConfigMap: %v", err)
	}
	var cfg map[string]any
	if err := yaml.Unmarshal([]byte(cm.Data["config.yaml"]), &cfg); err != nil {
		t.Fatalf("config.yaml in the provider ConfigMap: %v", err)
	}
	p, ok := cfg["substrate"].(map[string]any)["provider"].(map[string]any)
	if !ok {
		t.Fatalf("config.yaml in the provider ConfigMap has no substrate.provider")
	}
	p["grants"] = grants
	out, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	patch, _ := json.Marshal(map[string]any{"data": map[string]string{"config.yaml": string(out)}})
	kubectl(t, "", "patch", "configmap", provider, "--type=merge", "-p", string(patch))
}

func TestAquamanProvider(t *testing.T) {
	value, lateValue, rotated := os.Getenv("AQM_VALUE"), os.Getenv("AQM_LATE_VALUE"), os.Getenv("AQM_ROTATED")
	if value == "" || lateValue == "" || rotated == "" {
		t.Fatal("AQM_VALUE, AQM_LATE_VALUE and AQM_ROTATED must be set (scripts/e2e-substrate.sh sets them)")
	}
	ctx := context.Background()
	clients := e2e.GetClients()

	echo := e2e.DeployServerPod(t, ctx, echoServer)
	echoHost := echo.SvcName()
	atespace, _ := e2e.DeployProbe(t, "aqm", e2e.WithTrustBundle())

	baseGrants := map[string][]string{
		atespace:              {grantedRef},
		"some-other-atespace": {otherRef},
		atespace + "/not-me":  {otherRef},
	}
	setGrants(t, baseGrants)
	grantsWritten := time.Now()

	ref := &ateapi.ObjectRef{Atespace: atespace, Name: actorName}
	_, _ = clients.SubstrateAPI.SuspendActor(ctx, &ateapi.SuspendActorRequest{Actor: ref})
	_, _ = clients.SubstrateAPI.DeleteActor(ctx, &ateapi.DeleteActorRequest{Actor: ref})
	if _, err := clients.SubstrateAPI.CreateActor(ctx, &ateapi.CreateActorRequest{Actor: &ateapi.Actor{
		Metadata:      &ateapi.ResourceMetadata{Atespace: atespace, Name: actorName},
		ActorTemplate: &ateapi.ObjectRef{Atespace: atespace, Name: probeTemplate},
	}}); err != nil {
		t.Fatalf("CreateActor: %v", err)
	}
	t.Cleanup(func() {
		_, _ = clients.SubstrateAPI.SuspendActor(ctx, &ateapi.SuspendActorRequest{Actor: ref})
		if _, err := clients.SubstrateAPI.DeleteActor(ctx, &ateapi.DeleteActorRequest{Actor: ref}); err != nil && status.Code(err) != codes.NotFound {
			t.Logf("cleanup DeleteActor: %v", err)
		}
	})
	echoRule := e2e.EgressInjectHeader("Authorization", "Bearer ", secretURI(grantedRef), echoHost, echoHost+".cluster.local")
	echoRule.Https.Effects.ReplaceHeaders = append(echoRule.Https.Effects.ReplaceHeaders,
		&ateapi.CredentialHeader{Header: lateHeader, CredentialUri: secretURI(lateRef)})
	e2e.EnsureEgressPolicy(t, ctx, clients, ref,
		echoRule,
		e2e.EgressInjectHeaderHTTP("Authorization", "Bearer ", secretURI(grantedRef), echoHost, echoHost+".cluster.local"),
		e2e.EgressInjectHeader("Authorization", "Bearer ", secretURI(ungrantedRef), ungrantedHost),
		e2e.EgressInjectHeader("Authorization", "Bearer ", secretURI(otherRef), otherHost),
	)
	if _, err := clients.SubstrateAPI.ResumeActor(ctx, &ateapi.ResumeActorRequest{Actor: ref}); err != nil {
		t.Fatalf("ResumeActor: %v", err)
	}
	for deadline := time.Now().Add(2 * time.Minute); ; time.Sleep(time.Second) {
		resp, err := clients.SubstrateAPI.GetActor(ctx, &ateapi.GetActorRequest{Actor: ref})
		if err == nil && resp.GetStatus().GetState() == ateapi.ActorState_ACTOR_STATE_RUNNING {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("actor %s/%s is not RUNNING: %v %v", atespace, actorName, resp, err)
		}
	}
	t.Logf("AQM actor spiffe://substrate-actor.local/actor/%s/%s is running; origin %s", atespace, actorName, echoHost)

	rc, err := e2e.NewRouterClient(t, ctx)
	if err != nil {
		t.Fatalf("NewRouterClient: %v", err)
	}
	defer rc.Close()

	withPlaceholder := "header=" + url.QueryEscape("Authorization:"+placeholder)
	dialTLS := "dial=" + url.QueryEscape(echo.TLSAddress())

	// fetch has the actor request origin and returns what the actor got.
	fetch := func(origin string, params ...string) fetchResponse {
		t.Helper()
		path := "/fetch?roots=bundle&url=" + url.QueryEscape(origin)
		for _, p := range params {
			path += "&" + p
		}
		var last string
		for attempt := 1; attempt <= 20; attempt++ {
			resp, err := rc.Get(ctx, resources.ActorRef{Atespace: atespace, Name: actorName}, path)
			if err != nil {
				last = err.Error()
				time.Sleep(2 * time.Second)
				continue
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				last = fmt.Sprintf("router status %d: %s", resp.StatusCode, body)
				time.Sleep(2 * time.Second)
				continue
			}
			var out fetchResponse
			if err := json.Unmarshal(body, &out); err != nil {
				t.Fatalf("the probe's answer is not JSON: %q", body)
			}
			return out
		}
		t.Fatalf("no answer from the actor for %s: %s", origin, last)
		return fetchResponse{}
	}
	declared := func() fetchResponse { return fetch("https://"+echoHost+"/echoheaders", withPlaceholder) }
	viaHost := func(host string) fetchResponse {
		return fetch("https://"+host+"/echoheaders", withPlaceholder, dialTLS)
	}
	check := func(name string, ok bool, format string, args ...any) {
		t.Helper()
		if !ok {
			t.Errorf("AQM CHECK %s: FAIL: %s", name, fmt.Sprintf(format, args...))
			return
		}
		t.Logf("AQM CHECK %s: PASS: %s", name, fmt.Sprintf(format, args...))
	}
	// until repeats get until ok or the timeout, and reports how long it took.
	until := func(timeout time.Duration, get func() fetchResponse, ok func(fetchResponse) bool) (fetchResponse, time.Duration, bool) {
		start := time.Now()
		for {
			r := get()
			if ok(r) {
				return r, time.Since(start), true
			}
			if time.Since(start) > timeout {
				return r, time.Since(start), false
			}
			time.Sleep(time.Second)
		}
	}
	is := func(statusCode string) func(fetchResponse) bool {
		return func(r fetchResponse) bool { return r.Status == statusCode }
	}

	// The grants were written into the ConfigMap a moment ago and the pod was
	// not restarted: until the kubelet has projected the new file the answer
	// is 403, and 503 while the gateway is still connecting to a new provider.
	first, _, _ := until(4*time.Minute, declared, is("200"))
	check("injection-https", first.Status == "200" && first.auth() == "Bearer "+value,
		"upstream received Authorization %q (status %s, error %q, %s after the grants were written to the ConfigMap)",
		first.auth(), first.Status, first.Error, time.Since(grantsWritten).Round(time.Second))
	for i := 2; i <= 3; i++ {
		r := declared()
		check(fmt.Sprintf("injection-https-%d", i), r.Status == "200" && r.auth() == "Bearer "+value, "upstream received Authorization %q (status %s)", r.auth(), r.Status)
	}
	r := fetch("http://"+echoHost+"/echoheaders", withPlaceholder)
	check("injection-http", r.Status == "200" && r.auth() == "Bearer "+value, "upstream received Authorization %q (status %s)", r.auth(), r.Status)
	r = fetch("https://" + echoHost + "/echoheaders")
	check("no-placeholder-no-header", r.Status == "200" && r.auth() == "", "upstream received Authorization %q (status %s)", r.auth(), r.Status)

	r = viaHost(ungrantedHost)
	check("stored-but-not-granted", r.Status == "403", "status %s body %q", r.Status, r.Body)
	r = viaHost(otherHost)
	check("granted-to-another-atespace-and-another-actor", r.Status == "403", "status %s body %q", r.Status, r.Body)

	late := func() fetchResponse {
		return fetch("https://"+echoHost+"/echoheaders", "header="+url.QueryEscape(lateHeader+":placeholder"))
	}
	r = late()
	check("late-grant-before", r.Status == "403", "status %s", r.Status)
	withLate := map[string][]string{}
	for k, v := range baseGrants {
		withLate[k] = v
	}
	withLate[atespace+"/"+actorName] = []string{lateRef}
	setGrants(t, withLate)
	r, took, ok := until(4*time.Minute, late, is("200"))
	check("grant-added-without-restart", ok && r.header(lateHeader) == lateValue,
		"status %s, upstream received %s %q, %s after the ConfigMap edit", r.Status, lateHeader, r.header(lateHeader), took.Round(time.Second))
	setGrants(t, baseGrants)
	r, took, ok = until(4*time.Minute, late, is("403"))
	check("grant-removed-without-restart", ok, "status %s, %s after the ConfigMap edit", r.Status, took.Round(time.Second))

	kubectl(t, rotated, "exec", "-i", "deploy/"+provider, "--", "aquaman", "credentials", "add", "substrate-demo", "api_token", "--backend", "encrypted-file")
	r = declared()
	check("value-rotated", r.Status == "200" && r.auth() == "Bearer "+rotated, "upstream received Authorization %q (status %s)", r.auth(), r.Status)

	kubectl(t, "", "scale", "deploy/"+provider, "--replicas=0")
	kubectl(t, "", "wait", "--for=delete", "pod", "-l", "app="+provider, "--timeout=120s")
	r = declared()
	check("provider-down", r.Status == "503", "status %s body %q", r.Status, r.Body)
	r = fetch("https://" + echoHost + "/echoheaders")
	check("provider-down-request-without-placeholder", r.Status == "200", "status %s", r.Status)
	kubectl(t, "", "scale", "deploy/"+provider, "--replicas=1")
	kubectl(t, "", "rollout", "status", "deploy/"+provider, "--timeout=180s")
	r, took, ok = until(4*time.Minute, declared, is("200"))
	check("provider-back", ok && r.auth() == "Bearer "+rotated,
		"status %s, upstream received Authorization %q, %s after the pod was ready (the value is from the volume)", r.Status, r.auth(), took.Round(time.Second))

	hold := os.Getenv("AQM_HOLD_DIR")
	if hold == "" {
		return
	}
	for round := 1; ; round++ {
		_ = os.WriteFile(filepath.Join(hold, "waiting"), []byte(fmt.Sprint(round)), 0o600)
		t.Logf("AQM HOLD %d: waiting for %s/next or done", round, hold)
		for waitUntil := time.Now().Add(40 * time.Minute); ; time.Sleep(300 * time.Millisecond) {
			if _, err := os.Stat(filepath.Join(hold, "done")); err == nil || time.Now().After(waitUntil) {
				return
			}
			if _, err := os.Stat(filepath.Join(hold, "next")); err == nil {
				_ = os.Remove(filepath.Join(hold, "next"))
				break
			}
		}
		r := declared()
		t.Logf("AQM HOLD %d: status=%q error=%q authorization=%q", round, r.Status, r.Error, r.auth())
	}
}
