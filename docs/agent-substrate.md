# Use your own vault as an Agent Substrate credential provider

[Agent Substrate](https://github.com/agent-substrate/substrate) runs sandboxed agents ("actors") on Kubernetes and keeps credentials out of them: an actor sends a placeholder header, and Substrate's egress gateway replaces it with the real credential on the way out. The gateway gets that credential from a provider plugin. aquaman can be that provider, so the key comes from HashiCorp Vault or from an encrypted file aquaman keeps on a volume, only for the actors you named, with an audit entry for every fetch.

```bash
# 1. deploy the provider
kubectl -n ate-system create secret generic aquaman-credential-provider \
  --from-literal=AQUAMAN_ENCRYPTION_PASSWORD="$(openssl rand -base64 32)"
curl -fsSLO https://raw.githubusercontent.com/tech4242/aquaman/main/deploy/substrate/aquaman-credential-provider.yaml
kubectl apply -f aquaman-credential-provider.yaml      # after editing the grants in its ConfigMap, see below

# 2. store a key in it
printf '%s' "$GITHUB_TOKEN" | kubectl -n ate-system exec -i deploy/aquaman-credential-provider -- \
  aquaman credentials add github token

# 3. register the provider when you install the gateway
ate-setup deploy atenet \
  --credential-provider='{"name":"aquaman","address":"aquaman-credential-provider.ate-system.svc:50051"}'
```

An actor's `EgressPolicy` then names the key as `ate-secret://aquaman/github/token`.

This is the [hand to the host](how-it-fits.md) way of using aquaman: Substrate isolates the actor and injects the key. aquaman supplies it, decides which actor may have it and records it.

## If you are an agent

- **Hand this to the person who runs the cluster.** It changes a cluster-wide install and decides which actors get which keys. Give them this page; never ask for a key in the conversation.
- **You may run `kubectl -n ate-system exec deploy/aquaman-credential-provider -- aquaman substrate doctor`** and report what it says. It checks and changes nothing.
- **A 403 with the body `egress denied` on a request that carries the placeholder** means the provider refused or the key is missing. The reason is in the gateway's log, not in the response.

## Which actor gets which key

Nobody is at a screen to approve a request in a cluster, so the decision is written down beforehand. In the ConfigMap's `config.yaml`:

```yaml
substrate:
  provider:
    enabled: true
    grants:
      team-a:                       # every actor in atespace team-a
        - aquaman://github/token
      team-a/billing:               # only the actor "billing" in team-a
        - aquaman://stripe/api_key
```

- **Anything not listed is refused,** and refused before the vault is read, so a refusal says nothing about what the vault holds.
- **There are no wildcards.** A grant names one atespace or one actor, and one reference.
- **An edit takes effect without a restart,** once Kubernetes has updated the mounted file. That took between 5 and 89 seconds in our runs.
- **A grant is for Substrate only.** It does not let anything else in the pod or the cluster read the key from aquaman.

## Where the keys live

Set `credentials.backend` in the same `config.yaml`, and give the pod what the backend needs through the Secret:

| Backend | In the Secret | Notes |
|---|---|---|
| `encrypted-file` (the manifest's default) | `AQUAMAN_ENCRYPTION_PASSWORD` | aquaman's own encrypted file on the pod's volume. Store keys with `aquaman credentials add` in the pod; a key stored again is the one the next request carries. |
| `vault` (HashiCorp Vault, KV v2) | `VAULT_ADDR`, `VAULT_TOKEN` | Keys are at `secret/data/aquaman/<service>/<key>`, field `credential`. aquaman caches what it read for 15 minutes by default (`credentials.cacheTtlSeconds`), so a key replaced or deleted in Vault is still served until then, whichever way it was changed. To stop a key at once, remove its grant. |

The other backends need a person or a desktop session and do not fit a pod.

## Good to know

- **Only the gateway gets an answer.** The connection is TLS 1.3 with certificates Substrate issues to pods. aquaman answers a caller only if its certificate is the egress gateway's identity (`spiffe://cluster.local/ns/ate-system/sa/atenet-egress`) and within its dates. If your install uses another namespace or trust domain, set `substrate.provider.callerSpiffeId`.
- **Other pods are kept away by the NetworkPolicy in the manifest.** Any workload with a certificate from the same signer can complete the TLS handshake; aquaman refuses each of its calls as soon as the headers arrive, records the identity it presented (the same identity once a minute, at most twenty different ones, then a count), and limits what one connection can hold. It does not limit how many connections are opened. Your cluster's network plugin has to enforce NetworkPolicy for that.
- **You create no certificates.** The manifest asks Substrate for them through projected volumes. Substrate renews them, and aquaman picks up a renewed certificate without a restart.
- **The gateway asks on every request,** so removing a grant stops the next request, and every request that gets a key has its own audit entry: `kubectl exec ... -- aquaman audit tail`. Each entry names the actor and the reference. The provider does not start with the audit log switched off.
- **Refusals are summarised.** Per actor and minute, the same refusal is written once and at most twenty different ones, and at most 240 over all actors. Once a minute a summary entry says how many more there were: by name for refused connections, for requests with no readable actor and for the fifty actors with the most, and as one number for the other actors. It says how many, not which references they were for.
- **Fetches are rate-limited.** One actor is served 20 fetches a second, with 40 let through at once (`substrate.provider.fetchesPerSecond`), and all actors of one atespace together four times that (`atespaceFetchesPerSecond`). Above the limit the actor gets a 503. An actor over its own limit does not use up its atespace's, and one atespace does not use up another's. Several atespaces at their limit together still share one audit log and slow each other.
- **The audit log has a size.** It is kept in files of 10 MB, and the manifest keeps 100 of them (`audit.maxArchives`), about 2.5 million entries; older entries are deleted. That is a day and a half of one actor fetching at its full rate, about eight hours of one atespace at its full rate, and less with long names. Raise the number and the volume size together if you need longer.
- **What the actor sees when it goes wrong:** 403 when the provider refuses or the key is not there, 503 when the provider or the vault cannot be reached. The first request after the provider restarts can be a 503; in our runs it was back about 20 seconds after the pod was ready.
- **A stored value must fit in a header:** not empty, no line break. aquaman refuses one that does not and says why in the gateway's log.
- **One replica.** The vault file and the audit log are on one volume with one writer.
- **`aquaman substrate doctor`** in the pod checks the settings, the certificate files, the grants and the listener.

## What it does not do

- **It does not limit what the key is used for.** Which hosts get the key is Substrate's `EgressPolicy`; aquaman's method and path rules apply only to requests that pass through aquaman itself.
- **It takes the gateway's word for which actor is asking.** The gateway verifies the actor and tells the provider; the provider cannot check that itself. Whoever controls the gateway controls which grants apply.
- **No approval dialog, no links to existing vault items, no Bitwarden unlock.** Those need a person at a screen.

## The image

The manifest uses `ghcr.io/tech4242/aquaman-credential-provider`, published with each release for amd64 and arm64 and attested:

```bash
gh attestation verify oci://ghcr.io/tech4242/aquaman-credential-provider:<version> --repo tech4242/aquaman
```

`deploy/substrate/Dockerfile` builds it from a lockfile, and the base image is pinned by digest. The lockfile in the repository names the previous `aquaman-proxy` until the release's follow-up pull request is merged. A release makes its own copy with the version it publishes, and stops if anything else in it would change to a package that is not in one of the repository's lockfiles. That copy is not kept; the attestation is over the image. The manifest names the image by its version tag; to pin it harder, use the digest `gh attestation verify` reports.

## What was run

On 2026-11-27, against Agent Substrate v1.0.1 on a local kind cluster (gVisor sandboxes; microVM sandboxes need KVM and were not run):

- With the encrypted-file store: an actor's request arriving at an in-cluster HTTPS origin with the stored key in place of the placeholder, over HTTPS and HTTP, and without a header when it sent no placeholder.
- A stored key that was not granted, and one granted to another atespace and another actor: 403.
- A grant added and a grant removed by editing the ConfigMap, a key stored again, the provider stopped (503) and started again, a pod restart and a node restart with the volume kept.
- A certificate renewed by Substrate while the pod kept serving (lifetime shortened to one hour for the run).
- The HashiCorp Vault backend against a Vault 1.21 dev server in the cluster, once, by hand.
- `scripts/e2e-substrate.sh` in the repository repeats all but the last two on a cluster it creates and deletes.

Not run on a cluster: renewal of the gateway's own certificate, a connection reaching its maximum age, the rate limit, a Vault token with limited rights, and a Substrate version other than v1.0.1. The rate limit, the connection checks and a replaced authority are covered by tests against a real listener outside a cluster.
