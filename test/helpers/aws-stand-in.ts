/**
 * A local server that stands in for AWS. It checks the signature of every
 * request it receives the way AWS does, with the secret access key the test
 * stored in the vault, and records the verdict.
 *
 * The check does not use the proxy's signer. It signs the received request
 * again with `@smithy/signature-v4`, the signer the AWS SDK for JavaScript
 * uses, and compares signatures. On top of that it applies the rules AWS
 * documents: the Host header and every `x-amz-*` header are signed, the
 * date is recent, and `x-amz-content-sha256` is the hash of the body that
 * arrived.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';

export interface AwsStandInCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsStandInRequest {
  method: string;
  /** Request target as received, query included. */
  url: string;
  /** The Host header: the AWS host the proxy addressed. */
  host: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  region?: string;
  service?: string;
  accessKeyId?: string;
  signedHeaders: string[];
  /** True when the request is one AWS would have accepted from these credentials. */
  verified: boolean;
  /** Why not, when it is not. */
  problems: string[];
}

export interface AwsStandInReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface AwsStandIn {
  port: number;
  requests: AwsStandInRequest[];
  last(): AwsStandInRequest | undefined;
  clear(): void;
  /** What to answer a verified request with. The default is `200 {"ok":true}`. */
  respond(handler: (request: AwsStandInRequest) => AwsStandInReply | undefined): void;
  setCredentials(credentials: AwsStandInCredentials): void;
  stop(): Promise<void>;
}

const UNSIGNED_LITERALS = ['UNSIGNED-PAYLOAD', 'STREAMING-UNSIGNED-PAYLOAD-TRAILER'];
const MAX_SKEW_MS = 5 * 60 * 1000;

function parseAmzDate(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

function parseQuery(search: string): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const name = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? '' : decodeURIComponent(part.slice(eq + 1));
    const existing = query[name];
    if (existing === undefined) query[name] = value;
    else query[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return query;
}

async function verify(request: AwsStandInRequest, credentials: AwsStandInCredentials): Promise<void> {
  const problems = request.problems;
  const headerText = (name: string): string | undefined => {
    const v = request.headers[name];
    const text = Array.isArray(v) ? v.join(',') : v;
    // Node hands header bytes over one character per byte. AWS sees the bytes.
    return text === undefined ? undefined : Buffer.from(text, 'latin1').toString('utf8');
  };

  const authorization = headerText('authorization') ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(authorization);
  if (!m) {
    problems.push('no SigV4 Authorization header');
    return;
  }
  const [, accessKeyId, day, region, service, signedList, signature] = m;
  request.accessKeyId = accessKeyId;
  request.region = region;
  request.service = service;
  request.signedHeaders = signedList.split(';');

  if (accessKeyId !== credentials.accessKeyId) problems.push('the access key id is not the stored one');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.amazonaws\.com$/.test(request.host)) problems.push(`Host is not under amazonaws.com: ${request.host}`);
  if (!request.signedHeaders.includes('host')) problems.push('host is not signed');
  for (const name of Object.keys(request.headers)) {
    if (name.startsWith('x-amz-') && !request.signedHeaders.includes(name)) problems.push(`${name} is sent but not signed`);
  }
  for (const name of request.signedHeaders) {
    if (request.headers[name] === undefined) problems.push(`${name} is signed but not sent`);
  }

  const amzDate = headerText('x-amz-date') ?? '';
  const signingDate = parseAmzDate(amzDate);
  if (!signingDate) problems.push('x-amz-date is missing or malformed');
  else {
    if (Math.abs(Date.now() - signingDate.getTime()) > MAX_SKEW_MS) problems.push('x-amz-date is not the current time');
    if (amzDate.slice(0, 8) !== day) problems.push('the credential scope date is not the request date');
  }

  const contentSha = headerText('x-amz-content-sha256');
  if (contentSha === undefined) problems.push('x-amz-content-sha256 is missing');
  else if (UNSIGNED_LITERALS.includes(contentSha)) {
    if (service !== 's3') problems.push(`${contentSha} is only accepted by S3`);
  } else if (contentSha !== crypto.createHash('sha256').update(request.body).digest('hex')) {
    problems.push('x-amz-content-sha256 is not the hash of the body');
  }

  const token = headerText('x-amz-security-token');
  if (credentials.sessionToken === undefined && token !== undefined) problems.push('a session token was sent, and none is stored');
  if (credentials.sessionToken !== undefined && token !== credentials.sessionToken) problems.push('the session token is not the stored one');

  if (!signingDate) return;
  const q = request.url.indexOf('?');
  const signedHeaders: Record<string, string> = {};
  for (const name of request.signedHeaders) {
    const value = headerText(name);
    if (value !== undefined) signedHeaders[name] = value;
  }
  let expected: string | undefined;
  try {
    const signer = new SignatureV4({
      credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
      region,
      service,
      sha256: Sha256,
      // S3 signs the path as sent; every other service encodes it again.
      uriEscapePath: service !== 's3',
      applyChecksum: false,
    });
    const signed = await signer.sign(new HttpRequest({
      method: request.method,
      protocol: 'https:',
      hostname: request.host,
      path: q === -1 ? request.url : request.url.slice(0, q),
      query: parseQuery(q === -1 ? '' : request.url.slice(q)),
      headers: signedHeaders,
      body: request.body,
    }), { signingDate, signableHeaders: new Set(request.signedHeaders) });
    expected = /Signature=([0-9a-f]{64})$/.exec(signed.headers['authorization'] ?? '')?.[1];
    const expectedList = /SignedHeaders=([^,]+),/.exec(signed.headers['authorization'] ?? '')?.[1];
    if (expectedList !== signedList) problems.push(`the SDK signer would sign ${expectedList}, the request signs ${signedList}`);
  } catch (err) {
    problems.push(`could not re-sign: ${(err as Error).message}`);
  }
  if (expected !== signature) problems.push('the signature does not match the one made with the stored secret');
}

export async function startAwsStandIn(initial: AwsStandInCredentials): Promise<AwsStandIn> {
  let credentials = initial;
  let handler: (request: AwsStandInRequest) => AwsStandInReply | undefined = () => undefined;
  const requests: AwsStandInRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const request: AwsStandInRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        host: req.headers.host ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
        signedHeaders: [],
        verified: false,
        problems: [],
      };
      void verify(request, credentials).then(() => {
        request.verified = request.problems.length === 0;
        requests.push(request);
        if (!request.verified) {
          res.writeHead(403, { 'Content-Type': 'application/json', 'x-amzn-errortype': 'SignatureDoesNotMatch' });
          res.end(JSON.stringify({ __type: 'SignatureDoesNotMatch', message: request.problems.join('; ') }));
          return;
        }
        const reply = handler(request) ?? {};
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
        res.end(reply.body ?? JSON.stringify({ ok: true }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    requests,
    last: () => requests[requests.length - 1],
    clear: () => { requests.length = 0; },
    respond: (h) => { handler = h; },
    setCredentials: (c) => { credentials = c; },
    stop: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
