/**
 * AWS Signature Version 4, for the `sigv4` auth mode.
 *
 * An AWS client pointed at the proxy signs its request with placeholder
 * credentials. Nothing of that signature is kept: the proxy reads the region
 * and the signing name out of the client's `Authorization` header, decides
 * the AWS host itself, and signs the request it sends with the keys from the
 * vault. Everything here is pure (no I/O, Node's `crypto` only) so the signer
 * can be checked against AWS's published test suite.
 *
 * Rules this module holds:
 *
 *   - The host is always `<labels>.amazonaws.com`, assembled from labels that
 *     were each matched against `[a-z0-9-]`. No client string is ever used as
 *     a host, and no URL is resolved against another.
 *   - The Host header is always signed, so a signature made for one host is
 *     not one another host accepts.
 *   - A request the proxy cannot sign completely (chunk signatures made with
 *     the placeholder, query-string authentication, SigV4A) is refused with a
 *     reason instead of being forwarded half-signed.
 */

import * as crypto from 'node:crypto';

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
const SIGV4A_ALGORITHM = 'AWS4-ECDSA-P256-SHA256';

/** The only DNS suffix the proxy signs for. */
export const AWS_DNS_SUFFIX = 'amazonaws.com';

/**
 * What a routed program is given as its secret access key. AWS clients refuse
 * to start without one, and they sign with it; the proxy discards that
 * signature. It is a fixed public string, not a credential.
 */
export const SIGV4_PLACEHOLDER_SECRET = 'aquaman-proxy-signs-with-the-stored-key';

/**
 * Largest request body the proxy holds in memory to hash it. A signature
 * covers the SHA-256 of the body, so the body has to be read before the
 * first byte is sent. Larger uploads go through only where AWS accepts an
 * unsigned payload (see `payloadPlan`).
 */
export const SIGV4_MAX_BUFFERED_BODY = 16 * 1024 * 1024;

export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Signing region of the endpoints that carry no region in their name. */
const GLOBAL_ENDPOINT_REGION = 'us-east-1';

/** One DNS label: lower-case letters, digits and inner hyphens. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/**
 * A region code: `us-east-1`, `ap-southeast-5`, `us-gov-west-1`. Matching the
 * shape (and not only the alphabet) keeps the region slot from being used to
 * name some other subdomain of amazonaws.com.
 */
const REGION = /^[a-z]{2}(?:-[a-z]{2,12}){1,2}-[0-9]{1,2}$/;
/** Regions whose endpoints live under another DNS suffix, which the proxy does not sign for. */
const OTHER_PARTITION = /^(?:cn|eu-isoe|us-iso[a-z]?)-/;

const MAX_AUTHORIZATION_LENGTH = 2048;

export const SIGV4_HOST_SEGMENT = '_host';
export const SIGV4_GLOBAL_SEGMENT = '_global';

const POINT_AT_PROXY_FIX = 'Point an AWS SDK or the AWS CLI at this URL with AWS_ENDPOINT_URL and let it sign with the placeholder credentials; the proxy signs again with the stored keys';

export interface SigV4Refusal {
  ok: false;
  status: number;
  code: string;
  error: string;
  fix: string;
}

function refusal(status: number, code: string, error: string, fix: string): SigV4Refusal {
  return { ok: false, status, code, error, fix };
}

export interface SigV4Authorization {
  accessKeyId: string;
  /** `YYYYMMDD` as the client wrote it. Not reused: the proxy signs with its own clock. */
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
}

/**
 * Read `AWS4-HMAC-SHA256 Credential=<id>/<date>/<region>/<service>/aws4_request,
 * SignedHeaders=<a;b>, Signature=<hex>` strictly. Returns null for anything
 * that is not exactly that: another algorithm, the three parts in another
 * order or repeated, anything before or after, a scope with more or fewer
 * fields, upper-case in the region or service, or input past the length cap.
 * A header two parsers could read differently is never accepted as carrying
 * the route token or as naming where the request goes.
 */
export function parseSigV4Authorization(value: string | undefined): SigV4Authorization | null {
  if (typeof value !== 'string' || value.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = /^AWS4-HMAC-SHA256 Credential=([A-Za-z0-9_]{1,128})\/([0-9]{8})\/([a-z0-9-]{1,32})\/([a-z0-9-]{1,63})\/aws4_request, ?SignedHeaders=([a-z0-9-]+(?:;[a-z0-9-]+)*), ?Signature=[0-9a-f]{64}$/.exec(value);
  if (!match) return null;
  return {
    accessKeyId: match[1],
    date: match[2],
    region: match[3],
    service: match[4],
    signedHeaders: match[5].split(';'),
  };
}

/**
 * The access key id of a strictly valid SigV4 header: the one place a routed
 * AWS client can carry the route token. A SigV4A header is read the same
 * strict way, for its access key id only, so that a routed client that sends
 * one is told SigV4A is not signed instead of being told it has no token.
 */
export function sigV4TokenCandidates(value: string | undefined): string[] {
  const parsed = parseSigV4Authorization(value);
  if (parsed) return [parsed.accessKeyId];
  if (typeof value !== 'string' || value.length > MAX_AUTHORIZATION_LENGTH) return [];
  const sigv4a = /^AWS4-ECDSA-P256-SHA256 Credential=([A-Za-z0-9_]{1,128})\/[0-9]{8}\/[a-z0-9-]{1,63}\/aws4_request, ?SignedHeaders=[a-z0-9-]+(?:;[a-z0-9-]+)*, ?Signature=[0-9a-f]{64,160}$/.exec(value);
  return sigv4a ? [sigv4a[1]] : [];
}

/** Why an `Authorization` value the strict parser refused cannot be used, for the reply. */
export function sigV4AuthorizationRefusal(value: string | undefined): SigV4Refusal {
  if (typeof value === 'string' && value.startsWith(SIGV4A_ALGORITHM)) {
    return refusal(400, 'sigv4a_unsupported',
      'This request is signed with SigV4A (AWS4-ECDSA-P256-SHA256), which the proxy does not sign',
      'Use a regional endpoint that takes Signature Version 4; multi-Region access points and other SigV4A-only endpoints cannot be routed through the proxy');
  }
  if (typeof value !== 'string' || value === '') {
    return refusal(401, 'sigv4_authorization_missing',
      'Requests to aws must carry a Signature Version 4 Authorization header, which names the region and the service', POINT_AT_PROXY_FIX);
  }
  return refusal(400, 'sigv4_authorization_malformed',
    'The Authorization header is not a Signature Version 4 header the proxy can read (AWS4-HMAC-SHA256 Credential=<id>/<date>/<region>/<service>/aws4_request, SignedHeaders=..., Signature=...)',
    POINT_AT_PROXY_FIX);
}

export interface SigV4Target {
  ok: true;
  /** The AWS host the request is sent to and signed for. */
  host: string;
  /** Region in the credential scope of the proxy's signature. */
  region: string;
  /** Signing name in the credential scope. */
  service: string;
  /** The path sent to AWS, without the proxy's own leading segments. */
  segments: string[];
}

/**
 * Decide the AWS host for a request, from the client's credential scope and
 * the path after `/aws`:
 *
 *   /aws/<path>                 <service>.<region>.amazonaws.com
 *   /aws/_host/<prefix>/<path>  <prefix>.<region>.amazonaws.com
 *   /aws/_global/<path>         <service>.amazonaws.com, signed for us-east-1
 *
 * `<service>` and `<region>` are the signing name and region the client put
 * in its credential scope. `_host` is for endpoints whose name is not the
 * signing name (`bedrock-runtime` signs as `bedrock`), `_global` for the
 * services with one endpoint for every region (`iam.amazonaws.com`). A
 * per-service endpoint variable (`AWS_ENDPOINT_URL_<SERVICE>`) can point at
 * either. Every label is matched before it is used; the suffix is constant.
 *
 * The prefix is one label, never several. `<bucket>.s3` would address a
 * bucket by its virtual-hosted name with the bucket gone from the path, and
 * a policy rule written for `/<bucket>/**` would no longer see it.
 */
export function resolveSigV4Target(segments: readonly string[], scope: Pick<SigV4Authorization, 'region' | 'service'>): SigV4Target | SigV4Refusal {
  const hostFix = 'Use /aws/<path>, /aws/_host/<endpoint-prefix>/<path> or /aws/_global/<path>; see docs/aws.md';
  if (!DNS_LABEL.test(scope.service)) {
    return refusal(400, 'sigv4_service_invalid', 'The signing name in the credential scope is not a DNS label', POINT_AT_PROXY_FIX);
  }
  if (!REGION.test(scope.region)) {
    return refusal(400, 'sigv4_region_invalid', `"${scope.region}" in the credential scope is not an AWS region code such as us-east-1`, 'Set the region the client signs for (AWS_REGION)');
  }
  if (OTHER_PARTITION.test(scope.region)) {
    return refusal(400, 'sigv4_partition_unsupported', `Region ${scope.region} is served under another DNS suffix; the proxy signs for ${AWS_DNS_SUFFIX} only`, 'Use a region whose endpoints end in amazonaws.com, or bind the keys without --via-proxy');
  }

  let labels: string[];
  let region = scope.region;
  let rest: string[];
  if (segments[0] === SIGV4_GLOBAL_SEGMENT) {
    labels = [scope.service];
    region = GLOBAL_ENDPOINT_REGION;
    rest = segments.slice(1);
  } else if (segments[0] === SIGV4_HOST_SEGMENT) {
    const prefix = segments[1];
    if (typeof prefix !== 'string' || !DNS_LABEL.test(prefix)) {
      return refusal(400, 'sigv4_host_invalid', `/${SIGV4_HOST_SEGMENT}/ must be followed by an endpoint prefix that is one lower-case DNS label, such as bedrock-runtime`, hostFix);
    }
    labels = [prefix, scope.region];
    rest = segments.slice(2);
  } else {
    labels = [scope.service, scope.region];
    rest = [...segments];
  }
  const host = `${labels.join('.')}.${AWS_DNS_SUFFIX}`;
  if (host.length > 253) return refusal(400, 'sigv4_host_invalid', 'The AWS host name would be longer than a DNS name can be', hostFix);
  return { ok: true, host, region, service: scope.service, segments: rest };
}

/**
 * How many leading segments of the path after `/aws` are the proxy's own
 * host selectors. Request policy is matched on the path without them, which
 * is the path AWS receives, so a rule cannot be sidestepped by choosing the
 * host a different way.
 */
export function sigV4RoutingSegmentCount(segments: readonly string[]): number {
  if (segments[0] === SIGV4_GLOBAL_SEGMENT) return 1;
  if (segments[0] === SIGV4_HOST_SEGMENT) return Math.min(2, segments.length);
  return 0;
}

/** URI-encode as AWS defines it: every byte except `A-Z a-z 0-9 - . _ ~`, upper-case hex. */
export function awsUriEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The path segments sent to AWS. For S3 each one is written in the one
 * encoding S3 signs (the key decoded, then encoded by `awsUriEncode`), so the
 * path on the wire and the path in the signature are the same text however
 * the client spelled the key. Other services get the segments as sent.
 */
export function sigV4WireSegments(segments: readonly string[], service: string): string[] {
  return service === 's3' ? segments.map((s) => awsUriEncode(decodeURIComponent(s))) : [...segments];
}

/**
 * The canonical URI for a path as it goes on the wire (segments already
 * percent-encoded once). Most services sign the encoding of that wire form,
 * which encodes each `%` again. S3 signs the object key encoded once, so
 * there the segment is decoded first.
 */
export function canonicalUri(wireSegments: readonly string[], trailingSlash: boolean, service: string): string {
  if (wireSegments.length === 0) return '/';
  const once = service === 's3';
  const encoded = wireSegments.map((s) => awsUriEncode(once ? decodeURIComponent(s) : s));
  return `/${encoded.join('/')}${trailingSlash ? '/' : ''}`;
}

/** Query parameters that carry a signature or a credential: authentication in the URL, which the proxy cannot replace. */
const QUERY_AUTH_PARAMS = new Set(['x-amz-algorithm', 'x-amz-credential', 'x-amz-signature', 'x-amz-signedheaders', 'x-amz-security-token', 'x-amz-expires', 'awsaccesskeyid', 'signature']);

/**
 * The canonical query string for `?query` as sent. The query goes to AWS
 * unchanged, so it must have exactly one reading: a `+` (a space to some
 * decoders, a plus to others) or an escape that is not UTF-8 is refused.
 */
export function canonicalQuery(search: string): { ok: true; canonical: string } | SigV4Refusal {
  const pairs: Array<[string, string]> = [];
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (part === '') continue;
    if (part.includes('+')) {
      return refusal(400, 'sigv4_query_ambiguous', 'The query string contains "+", which AWS and other decoders read differently', 'Encode a space as %20 and a plus sign as %2B');
    }
    const eq = part.indexOf('=');
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
      value = eq === -1 ? '' : decodeURIComponent(part.slice(eq + 1));
    } catch {
      return refusal(400, 'sigv4_query_ambiguous', 'The query string contains a percent-escape that is not valid UTF-8', 'Percent-encode query parameters as UTF-8');
    }
    if (QUERY_AUTH_PARAMS.has(name.toLowerCase())) {
      return refusal(400, 'sigv4_presigned_unsupported',
        'The request carries its signature or a credential in the query string (a presigned URL), which the proxy cannot sign again',
        'Send the request with an Authorization header. A presigned URL has to be made by a program that holds the keys');
    }
    pairs.push([awsUriEncode(name), awsUriEncode(value)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return { ok: true, canonical: pairs.map(([n, v]) => `${n}=${v}`).join('&') };
}

export type PayloadPlan =
  /** Read the body (up to the cap), hash it, sign the hash. */
  | { ok: true; mode: 'hash' }
  /** Sign this literal in place of a hash and stream the body through. */
  | { ok: true; mode: 'literal'; value: string };

/**
 * How the body is covered by the signature, from the client's
 * `x-amz-content-sha256`. A hash the client sent is never trusted: the proxy
 * hashes the bytes it forwards. The two unsigned-payload literals are kept
 * for S3, the service AWS documents them for, and the body is then streamed
 * without a size cap. A body framed with chunk signatures was signed chunk by
 * chunk with the placeholder key, so it cannot be forwarded at all.
 */
export function payloadPlan(contentSha256: string | undefined, service: string): PayloadPlan | SigV4Refusal {
  const value = (contentSha256 ?? '').trim();
  if (value === 'UNSIGNED-PAYLOAD' || value === 'STREAMING-UNSIGNED-PAYLOAD-TRAILER') {
    if (service === 's3') return { ok: true, mode: 'literal', value };
    if (value === 'UNSIGNED-PAYLOAD') return { ok: true, mode: 'hash' };
  }
  if (value.startsWith('STREAMING-')) {
    return refusal(400, 'sigv4_streaming_unsupported',
      `The body is sent in aws-chunked framing (${value.slice(0, 64)}), which the proxy forwards only to S3 and only without chunk signatures`,
      'Turn off chunked payload signing in the client, or send the body in one piece');
  }
  return { ok: true, mode: 'hash' };
}

export interface SigV4SignInput {
  method: string;
  /** Canonical URI, as `canonicalUri()` returns it. */
  canonicalUri: string;
  /** Canonical query string, as `canonicalQuery()` returns it. */
  canonicalQuery: string;
  /** Headers to sign, any case. `host` and `x-amz-date` must be among them. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or an unsigned-payload literal. */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `YYYYMMDDTHHMMSSZ`, the same value as the `x-amz-date` header. */
  amzDate: string;
}

export interface SigV4Signature {
  authorization: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** `Date` as `YYYYMMDDTHHMMSSZ`. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Sign one request. Header values are trimmed and every run of white space
 * (a tab counts) becomes one space, which is what the AWS SDKs' signers do; a
 * value canonicalised differently here would be sent with a signature AWS
 * does not accept.
 */
export function signSigV4(input: SigV4SignInput): SigV4Signature {
  const headers = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = headers.map(([name]) => name).join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalUri,
    input.canonicalQuery,
    ...headers.map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  // Header values reach us one character per byte, and go out the same way,
  // so the bytes AWS hashes are the latin1 bytes of this string.
  const stringToSign = [
    SIGV4_ALGORITHM,
    input.amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest, 'latin1').digest('hex'),
  ].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return {
    authorization: `${SIGV4_ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/** Inbound headers that are part of the client's own signature, or name where it wanted the request to go. Never forwarded. */
const SIGV4_INBOUND_AUTH_HEADERS = new Set(['authorization', 'host', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256', 'x-aquaman-token']);
/** Headers that belong to the connection between client and proxy, not to the request. */
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'te', 'upgrade', 'expect']);

/** Whether an inbound header is dropped before the proxy builds the request it signs. */
export function isSigV4StrippedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SIGV4_INBOUND_AUTH_HEADERS.has(lower) || HOP_BY_HOP_HEADERS.has(lower);
}

/**
 * Whether a forwarded header is covered by the proxy's signature: every
 * `x-amz-*` header, as AWS requires, plus the two that describe the body.
 * Headers a hop may rewrite (user-agent, content-length, trace ids) are sent
 * unsigned.
 */
export function isSigV4SignedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('x-amz-') || lower === 'content-type' || lower === 'content-md5';
}

/**
 * Variables a routed AWS program needs besides its access key id and
 * `AWS_ENDPOINT_URL`, given the proxy URL for the service. None is a secret.
 * The two endpoint variables cover a global service and an endpoint whose
 * name is not its signing name; others are set the same way by hand.
 */
export function sigV4RouteEnv(url: string): Record<string, string> {
  return {
    AWS_SECRET_ACCESS_KEY: SIGV4_PLACEHOLDER_SECRET,
    AWS_ENDPOINT_URL_IAM: `${url}/${SIGV4_GLOBAL_SEGMENT}`,
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: `${url}/${SIGV4_HOST_SEGMENT}/bedrock-runtime`,
  };
}

/** How many request bodies the proxy holds in memory at once to hash for a signature. */
export const SIGV4_MAX_BUFFERED_BODIES = 8;

/** How long a client has to finish sending a body the proxy has to hash. */
export const SIGV4_BODY_READ_TIMEOUT_MS = 60_000;

/**
 * Paths a request names in a header, for policy. S3's CopyObject and
 * UploadPartCopy read the object named by `x-amz-copy-source`
 * (`/bucket/key`, `bucket/key`, optionally `?versionId=`), so a rule on a
 * bucket's path has to see that path too. `parse` turns a path into the
 * readings policy matches; a value it refuses, or one that names an access
 * point by ARN (which is not a path under any bucket), cannot be evaluated.
 */
export function sigV4HeaderPaths(
  headers: Record<string, string | string[] | undefined>,
  parse: (path: string) => string[] | null,
): { ok: true; paths: string[] } | { ok: false; reason: string } {
  const paths: string[] = [];
  const value = headers['x-amz-copy-source'];
  for (const raw of Array.isArray(value) ? value : value ? [value] : []) {
    const text = raw.trim();
    if (text === '') continue;
    let decodedStart = text.slice(0, 16);
    try { decodedStart = decodeURIComponent(decodedStart); } catch { /* the raw form is checked */ }
    if (/^\/?arn:/i.test(text) || /^\/?arn:/i.test(decodedStart)) {
      return { ok: false, reason: 'x-amz-copy-source names an access point by ARN, which path rules cannot be matched against' };
    }
    const readings = parse(text.startsWith('/') ? text : `/${text}`);
    if (readings === null) return { ok: false, reason: 'x-amz-copy-source is not a path the proxy can read' };
    for (const p of readings) if (!paths.includes(p)) paths.push(p);
  }
  return { ok: true, paths };
}
