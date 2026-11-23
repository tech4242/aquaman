// An app that calls AWS with the AWS SDK for JavaScript v3. Apart from the
// transport of one client it configures nothing in code: region, credentials
// and endpoints come from the environment `aquaman-coder exec` sets.
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { IAMClient, GetUserCommand } from '@aws-sdk/client-iam';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const only = process.argv[2];
const out = {
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('AWS_'))),
  calls: {},
};

async function call(name, fn, { onlyWhenAsked = false } = {}) {
  if (only ? only !== name : onlyWhenAsked) return;
  try {
    out.calls[name] = { ok: true, result: await fn() };
  } catch (err) {
    out.calls[name] = { ok: false, error: `${err.name}: ${err.message}`, status: err.$metadata?.httpStatusCode };
  }
}

const s3 = new S3Client({});
await call('s3.put', async () => (await s3.send(new PutObjectCommand({ Bucket: 'reports', Key: 'q3/summary 2026.txt', Body: 'quarterly summary', ContentType: 'text/plain' }))).ETag);
await call('s3.put-stream', async () => (await s3.send(new PutObjectCommand({ Bucket: 'reports', Key: 'q3/stream.bin', Body: Readable.from([Buffer.alloc(70000, 5)]), ContentLength: 70000 }))).ETag);
await call('s3.get', async () => (await (await s3.send(new GetObjectCommand({ Bucket: 'reports', Key: 'q3/summary 2026.txt' }))).Body.transformToString()));
await call('s3.list', async () => (await s3.send(new ListObjectsV2Command({ Bucket: 'reports', Prefix: 'q3/', Delimiter: '/' }))).Contents?.map((o) => o.Key));

const dynamodb = new DynamoDBClient({});
await call('dynamodb.get', async () => (await dynamodb.send(new GetItemCommand({ TableName: 'orders', Key: { id: { S: '42' } } }))).Item);

const iam = new IAMClient({});
await call('iam.get-user', async () => (await iam.send(new GetUserCommand({}))).User?.UserName);

// This client talks HTTP/2 unless it is given the HTTP/1.1 handler, and the
// proxy's listener is HTTP/1.1.
const invoke = async (client) => {
  const res = await client.send(new InvokeModelCommand({ modelId: 'anthropic.claude-opus-5-5-v1:0', contentType: 'application/json', body: JSON.stringify({ prompt: 'hello' }) }));
  return JSON.parse(Buffer.from(res.body).toString('utf8'));
};
await call('bedrock.invoke', () => invoke(new BedrockRuntimeClient({ requestHandler: new NodeHttpHandler() })));
await call('bedrock.invoke-default-transport', () => invoke(new BedrockRuntimeClient({})), { onlyWhenAsked: true });

console.log(JSON.stringify(out));
