# Call AWS without giving the app your AWS keys

An AWS client signs every request with the secret access key, so the key has to be wherever the signing happens. Usually that is the program your agent runs. With this page's setup it is aquaman's local proxy: the program holds a local token where the access key id would be and a placeholder where the secret would be, and the proxy signs each request with the keys from your vault (AWS Signature Version 4).

How a request travels:

1. The program's AWS client sends its request to aquaman on `127.0.0.1`, signed with the local token and the placeholder. The address and both values come from its environment.
2. aquaman reads the region and the service name from that signature, checks your request policy, and discards the signature.
3. aquaman signs the request with the access key id and secret access key from your vault and sends it to that service's host under `amazonaws.com` over HTTPS.

Requires aquaman 0.21.0 or later. This is the AWS form of [routing an app through the proxy](app-through-proxy.md); that page covers the listener, the route token and policies in general.

## Set up

Store the two keys, in your own terminal (the values are typed without echo and go to your vault):

```bash
aquaman credentials add aws access_key_id
aquaman credentials add aws secret_access_key
aquaman credentials add aws session_token        # only for temporary credentials
```

Then, in the project:

```bash
aquaman init --agent claude-code --no-hooks --loopback        # or: --agent codex
aquaman-coder bind AWS_ACCESS_KEY_ID=aquaman://aws/access_key_id --via-proxy AWS_ENDPOINT_URL
aquaman-coder exec -- node app.mjs
```

`bind` records one route, by the access key id. The secret access key is not bound to anything: it stays in the vault and only the proxy reads it. A command started by `exec` for the project then has:

| Variable | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | the route token (`aqm_rt_...`), which only this machine's proxy accepts |
| `AWS_SECRET_ACCESS_KEY` | `aquaman-proxy-signs-with-the-stored-key`, a fixed placeholder. It replaces a value already in your shell |
| `AWS_ENDPOINT_URL` | `http://127.0.0.1:8585/aws` |
| `AWS_ENDPOINT_URL_IAM` | `http://127.0.0.1:8585/aws/_global` |
| `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` | `http://127.0.0.1:8585/aws/_host/bedrock-runtime` |

The program needs no change if its AWS client reads the endpoint from the environment. `AWS_ENDPOINT_URL` and the per-service `AWS_ENDPOINT_URL_<SERVICE>` variables are described in AWS's SDKs and Tools Reference Guide under [Service-specific endpoints](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html) (read on 2026-11-23), which also lists the SDKs that read them. The region is the program's own setting (`AWS_REGION` or its configuration); aquaman takes it from each request.

While the access key id is bound only through the proxy and the secret access key is not bound or declared anywhere, `aquaman get` is refused for both.

## Which host a request goes to

The proxy builds the host name itself, always under `amazonaws.com`, from the region and service name in the request's signature and, for two special cases, from a marker at the start of the path:

| The program's endpoint | Host the proxy calls | Signed for |
|---|---|---|
| `http://127.0.0.1:8585/aws` | `<service>.<region>.amazonaws.com` | the region and service the client signed for |
| `http://127.0.0.1:8585/aws/_host/<prefix>` | `<prefix>.<region>.amazonaws.com` | the region and service the client signed for |
| `http://127.0.0.1:8585/aws/_global` | `<service>.amazonaws.com` | `us-east-1` and the service the client signed for |

- The first form covers a service whose endpoint is named after the service: `s3`, `dynamodb`, `sqs`.
- `_host/<prefix>` is for an endpoint whose name differs from the name its requests are signed with. Bedrock Runtime is at `bedrock-runtime.<region>.amazonaws.com` and signs as `bedrock`, which is why `exec` sets `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`. The prefix is one DNS label.
- `_global` is for a service with one endpoint for all regions, such as `iam.amazonaws.com`.
- For another service that needs one of these forms, set its own endpoint variable to `http://127.0.0.1:8585/aws/_global` or `http://127.0.0.1:8585/aws/_host/<prefix>` in the environment the command starts from. AWS lists the variable name for each service in [Identifiers for service-specific endpoints](https://docs.aws.amazon.com/sdkref/latest/guide/ss-endpoints-table.html).

Every part of the host is checked against lower-case letters, digits and hyphens, and the region has to have the shape of a region code. A region, service or prefix that contains a dot, a slash, a port or anything else is refused, and no request is sent. The `Host` header the program sent is never used for it. The host is part of what the proxy signs, so a signature made for one host is not valid for another.

S3 requests are sent path-style (`/bucket/key`), which is what the SDK for JavaScript produces for an endpoint at an IP address.

## What the proxy signs, and what it refuses

The proxy keeps nothing of the program's signature. It removes `Authorization`, `X-Amz-Date`, `X-Amz-Security-Token` and `X-Amz-Content-Sha256`, and any header that carries one of its own tokens or the placeholder secret. It then sets the date from its own clock, hashes the body it is about to send, adds the stored session token if there is one, and signs the host, every `x-amz-*` header, `Content-Type` and `Content-MD5`.

To hash a body the proxy has to hold it, so a request body is limited to 16 MiB. S3 uploads marked `UNSIGNED-PAYLOAD` or `STREAMING-UNSIGNED-PAYLOAD-TRAILER` are streamed through without that limit; the SDK for JavaScript uses the second form when it uploads a stream.

A request the proxy cannot sign completely is refused with an `error`, a `code` and a `fix`, and nothing is sent:

| Request | Status | `code` |
|---|---|---|
| A body sent as signed chunks (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`) | 400 | `sigv4_streaming_unsupported` |
| A presigned URL, or a session token in the query string | 400 | `sigv4_presigned_unsupported` |
| SigV4A (`AWS4-ECDSA-P256-SHA256`), used by multi-Region access points | 400 | `sigv4a_unsupported` |
| A body over 16 MiB that is not an unsigned S3 upload | 413 | `sigv4_body_too_large` |
| More than 8 bodies waiting to be hashed at the same time | 503 | `sigv4_busy` |
| A body that takes longer than 60 seconds to arrive | 408 | `sigv4_body_timeout` |
| A `+` in the query string, which decoders read two ways | 400 | `sigv4_query_ambiguous` |
| A doubled slash in the path | 400 | `sigv4_path_unsupported` |
| A region whose endpoints are under another suffix (`cn-north-1`) | 400 | `sigv4_partition_unsupported` |
| A local token or the placeholder in the path or query string | 400 | `sigv4_local_token_in_url` |

The table is what a request gets when it carries the route token in its `Authorization` header. A presigned URL fetched on its own has no header at all and gets the 401 of any request without a token.

For work that needs one of these, bind the keys without `--via-proxy`; the command then holds them while it runs.

Two more things to know:

- The listener speaks HTTP/1.1. The SDK for JavaScript's Bedrock Runtime client uses HTTP/2 unless told otherwise, and fails against the listener. Give it the HTTP/1.1 handler: `new BedrockRuntimeClient({ requestHandler: new NodeHttpHandler() })`, with `NodeHttpHandler` from `@smithy/node-http-handler`.
- The proxy does not follow redirects. A 3xx from AWS goes back to the program.

## Limit what the keys can do

Request policy applies to the method and to the path AWS receives, which is the path after `/aws` and after a `_host/<prefix>` or `_global` marker:

```yaml
policy:
  aws:
    defaultAction: allow
    rules:
      - { method: DELETE, path: "/reports-archive/**", action: deny }
```

A denied request gets a 403 from the proxy before any key is read. The rule above holds whichever endpoint form the request uses.

Policy sees the method and the path, with one addition: for an S3 copy (CopyObject, UploadPartCopy) the object named in `x-amz-copy-source` is checked as a read (`GET`), so a rule that stops reading a bucket also stops copying out of it, and a bucket your rules only allow reading can be copied from. The copy source has to begin with a plain bucket name: one given as an access point ARN, or with a `+` that is not percent-encoded, is refused when the service has rules, because it cannot be matched against a path. Beyond that, policy sees nothing else. A multi-object delete (`POST /<bucket>?delete`) names its keys in the body, so a `DELETE` rule on the bucket's path does not stop it: deny `POST` on the bucket's path as well. Many AWS APIs name the action in the `X-Amz-Target` header or in the body and use one path for everything (the DynamoDB and IAM calls in the runs below are all `POST /`), and the service is not in the path at all. So a path rule is useful where the path names the resource, as with S3 buckets, and it cannot tell `GetItem` from `DeleteTable`, or one service from another. What the keys may do is decided by the IAM policy attached to them: store keys for a user or role that has only the permissions this project needs.

Each forwarded request is one entry in the audit log, and so is each request refused by policy or by the checks above.

## What was run

- The signer is checked against AWS's published Signature Version 4 test suite: ten of its cases, including the plain GET, three query-string cases, a POST with a body and the two session-token cases. The expected canonical request, string to sign and signature are the suite's own files.
- An app using the AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`, `client-dynamodb`, `client-iam` and `client-bedrock-runtime` 3.1175.0) is started by `aquaman-coder exec` from a binding made by `aquaman-coder bind`, and calls S3 (`PutObject` with a string and with a stream, `GetObject`, `ListObjectsV2`), DynamoDB (`GetItem`), IAM (`GetUser`) and Bedrock Runtime (`InvokeModel`) through a real proxy. A local server stands in for AWS. It checks every request with the stored secret using the SDK's own signer (`@smithy/signature-v4` 5.7.5), and also that the host and every `x-amz-*` header are signed, that the date is current and that the body hash is the hash of the body. All seven calls were accepted and returned their results to the app; the stand-in received the stored access key id and never the token, the placeholder or the AWS variables of the shell the command was started from.
- A table of attacks is run against the same proxy and stand-in, one row each: steering the host through the region, the service, the `_host` prefix, the path, the request line and headers; sending the agent hosts' token in place of the route token; malformed and duplicated `Authorization` headers; header smuggling at the byte level; a client-supplied date, body hash or session token; tokens placed in other headers and in the URL; and bodies over the limit. In every row either nothing was sent, or what was sent verified and went to the AWS host the proxy chose.
- With a real `aquaman daemon` and the encrypted-file vault: `init`, `bind`, the environment `exec` gives a command, `aquaman get` refusing both keys, a policy denial and several of the refusals in the table above.

Every request in these runs went to the stand-in.

## What this does and does not give you

- The program, its dependencies and its logs hold a token and a placeholder. Neither is of use off your machine, and AWS accepts neither.
- The proxy does not check the signature the program made, because the program has no key to make a meaningful one with. Whatever holds the route token can have requests signed, within your request policy and the IAM permissions of the stored keys. A process running as you can read the token or change the binding, so this keeps the keys from leaking through the program. It is not a boundary between programs running as you.
- The stored keys are used as they are. A session token in the vault is sent until you replace it, and the proxy does not renew temporary credentials.
- The proxy looks for its tokens in headers as plain text and inside a `Basic` value, and in the URL. It does not look under other encodings or in the request body, so a program that copies its "access key id" there sends that local token to AWS.
- Only hosts under `amazonaws.com`, addressed as in the table above. An endpoint whose name has more than one label before the region, and an S3 bucket addressed by its own host name, cannot be reached this way.
- It is for your machine. In CI and production leave the endpoint variables unset and supply credentials the way that platform does.
