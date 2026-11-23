/**
 * Unit: the SigV4 signer against AWS's published Signature Version 4 test
 * suite, and the strict readers around it (the inbound Authorization header,
 * the AWS host, the query string, the payload plan).
 *
 * The vectors under test/fixtures/aws-sig-v4-test-suite are copied unchanged
 * from the suite as kept in awslabs/aws-c-auth
 * (tests/aws-signing-test-suite/v4, Apache-2.0). The expected canonical
 * request, string to sign and signature are read from those files, never
 * computed here.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseSigV4Authorization,
  sigV4TokenCandidates,
  sigV4AuthorizationRefusal,
  resolveSigV4Target,
  sigV4RoutingSegmentCount,
  sigV4WireSegments,
  canonicalQuery,
  canonicalUri,
  payloadPlan,
  signSigV4,
  sha256Hex,
  amzDate,
  awsUriEncode,
  isSigV4SignedHeader,
  isSigV4StrippedHeader,
  sigV4RouteEnv,
  SIGV4_PLACEHOLDER_SECRET,
} from '../../packages/proxy/src/sigv4.js';
import { routableKeys, routeRequiredKeys, routeKeyMismatch } from '../../packages/proxy/src/route-auth.js';
import { parseRequestTarget } from '../../packages/proxy/src/request-target.js';
import { ServiceRegistry, createServiceRegistry } from '../../packages/proxy/src/service-registry.js';

const SUITE = path.resolve(__dirname, '../fixtures/aws-sig-v4-test-suite');

interface Vector {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: string;
  context: {
    credentials: { access_key_id: string; secret_access_key: string; token?: string };
    region: string;
    service: string;
    sign_body: boolean;
    timestamp: string;
    omit_session_token?: boolean;
  };
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

function loadVector(name: string): Vector {
  const read = (file: string) => fs.readFileSync(path.join(SUITE, name, file), 'utf-8');
  const request = read('request.txt').replace(/^\n+/, '');
  const [head, ...rest] = request.split('\n\n');
  const lines = head.split('\n').filter((line) => line !== '');
  const [method, target] = lines[0].split(' ');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon)] = line.slice(colon + 1);
  }
  return {
    method,
    target,
    headers,
    body: rest.join('\n\n'),
    context: JSON.parse(read('context.json')),
    canonicalRequest: read('header-canonical-request.txt'),
    stringToSign: read('header-string-to-sign.txt'),
    signature: read('header-signature.txt').trim(),
  };
}

function signVector(v: Vector) {
  const target = parseRequestTarget(v.target);
  if (!target.ok) throw new Error(target.reason);
  const query = canonicalQuery(target.search);
  if (!query.ok) throw new Error(query.error);
  const date = amzDate(new Date(v.context.timestamp));
  const payloadHash = sha256Hex(v.body);
  const headers: Record<string, string> = { ...v.headers, 'X-Amz-Date': date };
  if (v.context.sign_body) headers['x-amz-content-sha256'] = payloadHash;
  if (v.context.credentials.token && !v.context.omit_session_token) headers['X-Amz-Security-Token'] = v.context.credentials.token;
  return signSigV4({
    method: v.method,
    canonicalUri: canonicalUri(target.segments, false, v.context.service),
    canonicalQuery: query.canonical,
    headers,
    payloadHash,
    region: v.context.region,
    service: v.context.service,
    accessKeyId: v.context.credentials.access_key_id,
    secretAccessKey: v.context.credentials.secret_access_key,
    amzDate: date,
  });
}

describe('signSigV4 against the published test suite', () => {
  it.each([
    ['get-vanilla'],
    ['get-vanilla-empty-query-key'],
    ['get-vanilla-query-order-key-case'],
    ['get-vanilla-query-unreserved'],
    ['get-header-value-trim'],
    ['post-vanilla'],
    ['post-vanilla-query'],
    ['post-x-www-form-urlencoded'],
    ['post-sts-header-before'],
    ['post-sts-header-after'],
  ])('%s', (name) => {
    const v = loadVector(name);
    const signed = signVector(v);
    expect(signed.canonicalRequest).toBe(v.canonicalRequest);
    expect(signed.stringToSign).toBe(v.stringToSign);
    expect(signed.signature).toBe(v.signature);
    expect(signed.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${v.context.credentials.access_key_id}/20150830/us-east-1/service/aws4_request, SignedHeaders=${signed.signedHeaders}, Signature=${v.signature}`,
    );
  });

  it('the fixtures are the ones the suite publishes', () => {
    // Guards against a vector being edited to fit the code.
    expect(loadVector('get-vanilla').signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(loadVector('post-x-www-form-urlencoded').body).toBe('Param1=value1');
    expect(loadVector('post-sts-header-before').context.credentials.token).toMatch(/^AQoDYXdzEPT/);
  });

  it('what the proxy signs is accepted back by its own strict reader', () => {
    const signed = signVector(loadVector('post-sts-header-before'));
    expect(parseSigV4Authorization(signed.authorization)).toEqual({
      accessKeyId: 'AKIDEXAMPLE', date: '20150830', region: 'us-east-1', service: 'service',
      signedHeaders: ['host', 'x-amz-date', 'x-amz-security-token'],
    });
  });
});

describe('canonical URI and query', () => {
  it('encodes the wire path again for every service but S3', () => {
    expect(canonicalUri([], false, 'dynamodb')).toBe('/');
    expect(canonicalUri(['model', 'anthropic.claude%3A0', 'invoke'], false, 'bedrock')).toBe('/model/anthropic.claude%253A0/invoke');
    expect(canonicalUri(['2015-03-31', 'functions'], true, 'lambda')).toBe('/2015-03-31/functions/');
    expect(canonicalUri(['a:b'], false, 'execute-api')).toBe('/a%3Ab');
  });

  it('encodes an S3 key once, however the client spelled it', () => {
    expect(canonicalUri(['bucket', 'a%20b', "it's(1)*.txt"], false, 's3')).toBe('/bucket/a%20b/it%27s%281%29%2A.txt');
    expect(canonicalUri(['bucket', 'a+b'], false, 's3')).toBe('/bucket/a%2Bb');
    expect(canonicalUri(['bucket', 'dir'], true, 's3')).toBe('/bucket/dir/');
  });

  it('an S3 path goes on the wire in the encoding that is signed; other services get it as sent', () => {
    const sent = ['bucket', 'a%20b', "it's(1)*.txt", '@x:y', 'a+b', '%C3%BC'];
    const wire = sigV4WireSegments(sent, 's3');
    expect(wire).toEqual(['bucket', 'a%20b', 'it%27s%281%29%2A.txt', '%40x%3Ay', 'a%2Bb', '%C3%BC']);
    expect(canonicalUri(wire, false, 's3')).toBe(`/${wire.join('/')}`);
    expect(sigV4WireSegments(sent, 'lambda')).toEqual(sent);
  });

  it('awsUriEncode leaves only the unreserved characters', () => {
    expect(awsUriEncode("-._~Az09 !'()*/:=&+é")).toBe('-._~Az09%20%21%27%28%29%2A%2F%3A%3D%26%2B%C3%A9');
  });

  it.each([
    ['', ''],
    ['?', ''],
    ['?b=2&a=1', 'a=1&b=2'],
    ['?a=2&a=1', 'a=1&a=2'],
    ['?acl', 'acl='],
    ['?list-type=2&prefix=a%2Fb', 'list-type=2&prefix=a%2Fb'],
    ['?k=a%20b&&x=%7e', 'k=a%20b&x=~'],
    ['?k=a=b', 'k=a%3Db'],
    ['?A=1&a=2', 'A=1&a=2'],
  ])('canonical query of %j', (search, canonical) => {
    expect(canonicalQuery(search)).toEqual({ ok: true, canonical });
  });

  it.each([
    ['a plus sign', '?prefix=a+b', 'sigv4_query_ambiguous'],
    ['an escape that is not UTF-8', '?k=%ff', 'sigv4_query_ambiguous'],
    ['X-Amz-Signature', '?X-Amz-Signature=abc', 'sigv4_presigned_unsupported'],
    ['X-Amz-Credential, lower case', '?x-amz-credential=AKID%2F20150830%2Fus-east-1%2Fs3%2Faws4_request', 'sigv4_presigned_unsupported'],
    ['an encoded spelling of X-Amz-Signature', '?X-Amz-%53ignature=abc', 'sigv4_presigned_unsupported'],
    ['a session token in the query', '?X-Amz-Security-Token=abc', 'sigv4_presigned_unsupported'],
    ['a SigV2 query signature', '?AWSAccessKeyId=AKID&Signature=abc', 'sigv4_presigned_unsupported'],
  ])('refuses a query with %s', (_name, search, code) => {
    const result = canonicalQuery(search);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 400, code });
    expect((result as { fix: string }).fix).not.toBe('');
  });
});

const SIG = 'a'.repeat(64);
const auth = (credential: string, rest = `SignedHeaders=host;x-amz-date, Signature=${SIG}`) => `AWS4-HMAC-SHA256 Credential=${credential}, ${rest}`;

describe('parseSigV4Authorization', () => {
  it.each([
    ['the form the SDKs send', auth('AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request')],
    ['no space after the commas', `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request,SignedHeaders=host;x-amz-date,Signature=${SIG}`],
    ['a route token as the access key id', auth(`aqm_rt_${'0'.repeat(48)}/20150830/us-east-1/s3/aws4_request`)],
  ])('accepts %s', (_name, value) => {
    expect(parseSigV4Authorization(value)).toMatchObject({ region: 'us-east-1', service: 's3', date: '20150830' });
  });

  it.each([
    ['nothing', undefined],
    ['an empty value', ''],
    ['a bearer token', 'Bearer abc'],
    ['SigV4A', `AWS4-ECDSA-P256-SHA256 Credential=AKID/20150830/s3/aws4_request, SignedHeaders=host, Signature=${SIG}`],
    ['a lower-case algorithm', auth('AKID/20150830/us-east-1/s3/aws4_request').replace('AWS4-HMAC-SHA256', 'aws4-hmac-sha256')],
    ['two spaces after the algorithm', auth('AKID/20150830/us-east-1/s3/aws4_request').replace('SHA256 ', 'SHA256  ')],
    ['a tab after the algorithm', auth('AKID/20150830/us-east-1/s3/aws4_request').replace('SHA256 ', 'SHA256\t')],
    ['text before the algorithm', ` ${auth('AKID/20150830/us-east-1/s3/aws4_request')}`],
    ['text after the signature', `${auth('AKID/20150830/us-east-1/s3/aws4_request')} x`],
    ['a second credential', auth('AKID/20150830/us-east-1/s3/aws4_request, Credential=AKID/20150830/eu-west-1/iam/aws4_request')],
    ['a scope with a fifth field', auth('AKID/20150830/us-east-1/s3/extra/aws4_request')],
    ['a scope without a region', auth('AKID/20150830/s3/aws4_request')],
    ['a dot in the region', auth('AKID/20150830/us-east-1.evil.example/s3/aws4_request')],
    ['a dot in the service', auth('AKID/20150830/us-east-1/s3.evil.example/aws4_request')],
    ['a slash smuggled into the service', auth('AKID/20150830/us-east-1/s3%2Fx/aws4_request')],
    ['an upper-case region', auth('AKID/20150830/US-EAST-1/s3/aws4_request')],
    ['an at sign in the service', auth('AKID/20150830/us-east-1/s3@evil.example/aws4_request')],
    ['a date that is not eight digits', auth('AKID/2015083/us-east-1/s3/aws4_request')],
    ['another terminator', auth('AKID/20150830/us-east-1/s3/aws4_requesT')],
    ['the parts in another order', `AWS4-HMAC-SHA256 SignedHeaders=host, Credential=AKID/20150830/us-east-1/s3/aws4_request, Signature=${SIG}`],
    ['a signature that is not 64 hex digits', auth('AKID/20150830/us-east-1/s3/aws4_request', 'SignedHeaders=host, Signature=abc')],
    ['an upper-case signature', auth('AKID/20150830/us-east-1/s3/aws4_request', `SignedHeaders=host, Signature=${'A'.repeat(64)}`)],
    ['signed headers with a space', auth('AKID/20150830/us-east-1/s3/aws4_request', `SignedHeaders=host; x-amz-date, Signature=${SIG}`)],
    ['an access key id with a slash', auth('AK/ID/20150830/us-east-1/s3/aws4_request')],
    ['an access key id past 128 characters', auth(`${'A'.repeat(129)}/20150830/us-east-1/s3/aws4_request`)],
    ['a value past the length cap', auth('AKID/20150830/us-east-1/s3/aws4_request', `SignedHeaders=${Array(600).fill('x-h').join(';')}, Signature=${SIG}`)],
    ['a newline in the value', auth('AKID/20150830/us-east-1/s3/aws4_request\n')],
  ])('refuses %s', (_name, value) => {
    expect(parseSigV4Authorization(value)).toBeNull();
    // A SigV4A header names an access key id, and nothing else is read from it.
    expect(sigV4TokenCandidates(value)).toEqual(typeof value === 'string' && value.startsWith('AWS4-ECDSA') ? ['AKID'] : []);
  });

  it.each([
    ['a region in the scope', `AWS4-ECDSA-P256-SHA256 Credential=AKID/20150830/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=${SIG}`],
    ['text after the signature', `AWS4-ECDSA-P256-SHA256 Credential=AKID/20150830/s3/aws4_request, SignedHeaders=host, Signature=${SIG} x`],
    ['a second credential', `AWS4-ECDSA-P256-SHA256 Credential=AKID/20150830/s3/aws4_request, Credential=OTHER/20150830/s3/aws4_request, SignedHeaders=host, Signature=${SIG}`],
    ['a signature that is not hex', `AWS4-ECDSA-P256-SHA256 Credential=AKID/20150830/s3/aws4_request, SignedHeaders=host, Signature=${'z'.repeat(64)}`],
    ['a lower-case algorithm', `aws4-ecdsa-p256-sha256 Credential=AKID/20150830/s3/aws4_request, SignedHeaders=host, Signature=${SIG}`],
  ])('a SigV4A header with %s names no access key id', (_name, value) => {
    expect(sigV4TokenCandidates(value)).toEqual([]);
  });

  it('says why, with a fix, for each kind of refusal', () => {
    expect(sigV4AuthorizationRefusal(undefined)).toMatchObject({ status: 401, code: 'sigv4_authorization_missing' });
    expect(sigV4AuthorizationRefusal('Bearer x')).toMatchObject({ status: 400, code: 'sigv4_authorization_malformed' });
    expect(sigV4AuthorizationRefusal(`AWS4-ECDSA-P256-SHA256 Credential=AKID/20150830/s3/aws4_request, SignedHeaders=host, Signature=${SIG}`)).toMatchObject({ status: 400, code: 'sigv4a_unsupported' });
    for (const value of [undefined, 'Bearer x', 'AWS4-ECDSA-P256-SHA256 x']) {
      expect(sigV4AuthorizationRefusal(value).fix).not.toBe('');
    }
  });
});

describe('resolveSigV4Target', () => {
  const scope = (region: string, service: string) => ({ region, service });

  it.each([
    ['the default host', ['my-bucket', 'key'], scope('eu-central-1', 's3'), 's3.eu-central-1.amazonaws.com', 'eu-central-1', ['my-bucket', 'key']],
    ['no path at all', [], scope('us-east-1', 'dynamodb'), 'dynamodb.us-east-1.amazonaws.com', 'us-east-1', []],
    ['a GovCloud region', [], scope('us-gov-west-1', 'sts'), 'sts.us-gov-west-1.amazonaws.com', 'us-gov-west-1', []],
    ['an endpoint prefix that is not the signing name', ['_host', 'bedrock-runtime', 'model', 'm', 'invoke'], scope('us-west-2', 'bedrock'), 'bedrock-runtime.us-west-2.amazonaws.com', 'us-west-2', ['model', 'm', 'invoke']],
    ['a global endpoint, signed for us-east-1', ['_global'], scope('eu-west-1', 'iam'), 'iam.amazonaws.com', 'us-east-1', []],
  ])('%s', (_name, segments, s, host, region, rest) => {
    expect(resolveSigV4Target(segments, s)).toEqual({ ok: true, host, region, service: s.service, segments: rest });
  });

  it.each([
    ['a region that is one word', [], scope('elb', 's3'), 'sigv4_region_invalid'],
    ['a region shaped like an EC2 zone name', [], scope('compute-1', 's3'), 'sigv4_region_invalid'],
    ['a region with a trailing hyphen', [], scope('us-east-1-', 's3'), 'sigv4_region_invalid'],
    ['a China region', [], scope('cn-north-1', 's3'), 'sigv4_partition_unsupported'],
    ['an isolated region', [], scope('us-iso-east-1', 's3'), 'sigv4_partition_unsupported'],
    ['a service that starts with a hyphen', [], scope('us-east-1', '-s3'), 'sigv4_service_invalid'],
    ['a service that ends with a hyphen', [], scope('us-east-1', 's3-'), 'sigv4_service_invalid'],
    ['_host with nothing after it', ['_host'], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
    ['a prefix with an upper-case letter', ['_host', 'Bedrock-runtime'], scope('us-east-1', 'bedrock'), 'sigv4_host_invalid'],
    ['a prefix with an empty label', ['_host', 'a..b'], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
    ['a prefix ending in a dot', ['_host', 'evil.example.'], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
    ['a prefix with a port', ['_host', 'evil.example:443'], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
    ['a prefix with user info', ['_host', 'user@evil.example'], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
    ['a prefix with an encoded slash', ['_host', 'evil.example%2Fx'], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
    ['a prefix with an encoded dot', ['_host', 'evil%2Eexample'], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
    ['a prefix with an underscore', ['_host', 'evil_example'], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
    ['a prefix of two labels', ['_host', 'runtime.sagemaker'], scope('us-east-1', 'sagemaker'), 'sigv4_host_invalid'],
    ['a bucket addressed by its virtual-hosted name', ['_host', 'my-bucket.s3', 'key'], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
    ['a prefix label longer than 63 characters', ['_host', 'a'.repeat(64)], scope('us-east-1', 's3'), 'sigv4_host_invalid'],
  ])('refuses %s', (_name, segments, s, code) => {
    const result = resolveSigV4Target(segments, s);
    expect(result).toMatchObject({ ok: false, status: 400, code });
    expect((result as { fix: string }).fix).not.toBe('');
  });

  it('every accepted host ends in .amazonaws.com and holds only DNS characters', () => {
    const inputs: Array<[string[], { region: string; service: string }]> = [
      [[], scope('us-east-1', 's3')],
      [['_host', 'bedrock-runtime'], scope('ap-southeast-5', 'bedrock')],
      [['_global', 'x'], scope('me-central-1', 'route53')],
    ];
    for (const [segments, s] of inputs) {
      const result = resolveSigV4Target(segments, s);
      expect(result.ok && /^[a-z0-9.-]+\.amazonaws\.com$/.test(result.host)).toBe(true);
    }
  });
});

describe('sigV4RoutingSegmentCount', () => {
  it.each([
    [['bucket', 'key'], 0],
    [[], 0],
    [['_global'], 1],
    [['_global', 'x'], 1],
    [['_host', 'bedrock-runtime', 'model'], 2],
    [['_host'], 1],
    [['bucket', '_host', 'x'], 0],
  ])('%j has %i host-selecting segments', (segments, count) => {
    expect(sigV4RoutingSegmentCount(segments)).toBe(count);
  });
});

describe('payloadPlan', () => {
  const HASH = 'f'.repeat(64);
  it.each([
    ['no header', undefined, 'dynamodb', { ok: true, mode: 'hash' }],
    ['a hash from the client, which is not trusted', HASH, 's3', { ok: true, mode: 'hash' }],
    ['UNSIGNED-PAYLOAD to S3', 'UNSIGNED-PAYLOAD', 's3', { ok: true, mode: 'literal', value: 'UNSIGNED-PAYLOAD' }],
    ['UNSIGNED-PAYLOAD to another service, which gets a real hash', 'UNSIGNED-PAYLOAD', 'dynamodb', { ok: true, mode: 'hash' }],
    ['an unsigned trailer upload to S3', 'STREAMING-UNSIGNED-PAYLOAD-TRAILER', 's3', { ok: true, mode: 'literal', value: 'STREAMING-UNSIGNED-PAYLOAD-TRAILER' }],
  ])('%s', (_name, value, service, plan) => {
    expect(payloadPlan(value, service)).toEqual(plan);
  });

  it.each([
    ['signed chunks', 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD', 's3'],
    ['signed chunks with a trailer', 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER', 's3'],
    ['SigV4A signed chunks', 'STREAMING-AWS4-ECDSA-P256-SHA256-PAYLOAD', 's3'],
    ['an unsigned trailer upload to a service other than S3', 'STREAMING-UNSIGNED-PAYLOAD-TRAILER', 'glacier'],
    ['a streaming mode the proxy does not know', 'STREAMING-SOMETHING-NEW', 's3'],
  ])('refuses %s', (_name, value, service) => {
    const plan = payloadPlan(value, service);
    expect(plan).toMatchObject({ ok: false, status: 400, code: 'sigv4_streaming_unsupported' });
    expect((plan as { fix: string }).fix).not.toBe('');
  });
});

describe('headers', () => {
  it('drops what the client signature was made of, and what belongs to the hop', () => {
    for (const name of ['Authorization', 'Host', 'X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256', 'x-aquaman-token', 'Connection', 'Proxy-Authorization', 'Expect', 'TE']) {
      expect(isSigV4StrippedHeader(name), name).toBe(true);
    }
    for (const name of ['X-Amz-Target', 'Content-Type', 'x-amz-meta-owner', 'User-Agent', 'Content-Length']) {
      expect(isSigV4StrippedHeader(name), name).toBe(false);
    }
  });

  it('signs every x-amz header and the two that describe the body', () => {
    for (const name of ['x-amz-target', 'X-Amz-Meta-Owner', 'content-type', 'Content-MD5']) expect(isSigV4SignedHeader(name), name).toBe(true);
    for (const name of ['user-agent', 'content-length', 'x-amzn-trace-id', 'amz-sdk-request', 'accept']) expect(isSigV4SignedHeader(name), name).toBe(false);
  });
});

describe('routing', () => {
  const aws = createServiceRegistry({ configPath: '/nonexistent/services.yaml' }).get('aws')!;

  it('aws is a builtin that signs, routed by its access key id alone', () => {
    expect(ServiceRegistry.isBuiltinService('aws')).toBe(true);
    expect(aws.authMode).toBe('sigv4');
    expect(new URL(aws.upstream).hostname).toBe('amazonaws.com');
    expect(routableKeys(aws)).toEqual(['access_key_id']);
    expect(routeRequiredKeys(aws)).toEqual(['access_key_id', 'secret_access_key']);
  });

  it('routeRequiredKeys is routableKeys for the other modes', () => {
    const basic = { authMode: 'basic' as const, credentialKey: 'email', additionalCredentialKeys: ['api_token'] };
    expect(routeRequiredKeys(basic)).toEqual(routableKeys(basic));
    expect(routeRequiredKeys({ credentialKey: 'api_key' })).toEqual(['api_key']);
    expect(routeRequiredKeys({ authMode: 'oauth' as const, credentialKey: 'client_id' })).toEqual([]);
  });

  it('routing by the secret access key is refused with the reference to use', () => {
    const mismatch = routeKeyMismatch('aws', routableKeys(aws), 'secret_access_key', 'sigv4');
    expect(mismatch.fix).toBe('Use aquaman://aws/access_key_id');
    expect(mismatch.error).toContain('aws/secret_access_key stays in the vault');
  });

  it('services.yaml cannot declare a sigv4 service', () => {
    const registry = createServiceRegistry({ configPath: '/nonexistent/services.yaml' });
    expect(registry.validateService({ name: 'minio', upstream: 'https://minio.example', authHeader: 'Authorization', credentialKey: 'access_key_id', authMode: 'sigv4' }))
      .toEqual({ valid: false, error: 'authMode sigv4 is only available as the builtin "aws" service' });
    expect(() => registry.register({ name: 'minio', upstream: 'https://minio.example', authHeader: 'Authorization', credentialKey: 'access_key_id', authMode: 'sigv4' })).toThrow(/sigv4/);
  });

  it('the variables a routed AWS program is also given hold no stored value', () => {
    expect(sigV4RouteEnv('http://127.0.0.1:8585/aws')).toEqual({
      AWS_SECRET_ACCESS_KEY: SIGV4_PLACEHOLDER_SECRET,
      AWS_ENDPOINT_URL_IAM: 'http://127.0.0.1:8585/aws/_global',
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'http://127.0.0.1:8585/aws/_host/bedrock-runtime',
    });
  });
});
