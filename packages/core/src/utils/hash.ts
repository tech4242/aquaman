/**
 * Cryptographic utilities for hash chains and integrity verification
 */

import * as crypto from 'node:crypto';

const HASH_ALGORITHM = 'sha256';

export function computeHash(data: string): string {
  return crypto.createHash(HASH_ALGORITHM).update(data).digest('hex');
}

export function computeChainedHash(data: string, previousHash: string): string {
  return computeHash(previousHash + data);
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export interface SigningKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}

export function sign(data: string, privateKey: string): string {
  const signature = crypto.sign(null, Buffer.from(data), privateKey);
  return signature.toString('base64');
}

export function verify(data: string, signature: string, publicKey: string): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(data),
      publicKey,
      Buffer.from(signature, 'base64')
    );
  } catch {
    return false;
  }
}

export function encryptWithPassword(data: string, password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 600000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(data, 'utf-8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  return [
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted
  ].join(':');
}

export function decryptWithPassword(encryptedData: string, password: string): string {
  const [saltB64, ivB64, authTagB64, encrypted] = encryptedData.split(':');

  if (!saltB64 || !ivB64 || !authTagB64 || !encrypted) {
    throw new Error('Invalid encrypted data format');
  }

  const salt = Buffer.from(saltB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const key = crypto.pbkdf2Sync(password, salt, 600000, 32, 'sha256');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'base64', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}

export interface SelfSignedCert {
  cert: string;
  key: string;
}

/**
 * Generate a self-signed TLS certificate using Node.js crypto
 * No external dependencies required
 */
export function generateSelfSignedCert(commonName: string, days = 365): SelfSignedCert {
  // Generate RSA key pair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // Create a self-signed certificate using the built-in X509Certificate
  // We need to manually construct the certificate since Node.js doesn't have
  // a built-in certificate generation API

  const now = new Date();
  const notBefore = now;
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // Generate serial number
  const serialNumber = crypto.randomBytes(16).toString('hex');

  // Build certificate using ASN.1 DER encoding
  const cert = buildSelfSignedCert({
    commonName,
    publicKey,
    privateKey,
    notBefore,
    notAfter,
    serialNumber
  });

  return {
    cert,
    key: privateKey
  };
}

interface CertParams {
  commonName: string;
  publicKey: string;
  privateKey: string;
  notBefore: Date;
  notAfter: Date;
  serialNumber: string;
}

function buildSelfSignedCert(params: CertParams): string {
  // Extract the public key bytes from PEM
  const pubKeyDer = pemToDer(params.publicKey, 'PUBLIC KEY');

  // Build TBSCertificate (To Be Signed Certificate)
  const tbsCert = buildTBSCertificate(params, pubKeyDer);

  // Sign the TBSCertificate
  const signature = crypto.sign('sha256', tbsCert, params.privateKey);

  // Build the complete certificate
  const cert = buildCertificate(tbsCert, signature);

  // Convert to PEM
  return derToPem(cert, 'CERTIFICATE');
}

function pemToDer(pem: string, label: string): Buffer {
  const base64 = pem
    .replace(`-----BEGIN ${label}-----`, '')
    .replace(`-----END ${label}-----`, '')
    .replace(/\s/g, '');
  return Buffer.from(base64, 'base64');
}

function derToPem(der: Buffer, label: string): string {
  const base64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ASN.1 DER encoding helpers
function encodeLength(length: number): Buffer {
  if (length < 128) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let temp = length;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeSequence(items: Buffer[]): Buffer {
  const content = Buffer.concat(items);
  const lengthBytes = encodeLength(content.length);
  return Buffer.concat([Buffer.from([0x30]), lengthBytes, content]);
}

function encodeSet(items: Buffer[]): Buffer {
  const content = Buffer.concat(items);
  const lengthBytes = encodeLength(content.length);
  return Buffer.concat([Buffer.from([0x31]), lengthBytes, content]);
}

function encodeInteger(value: Buffer | number): Buffer {
  let bytes: Buffer;
  if (typeof value === 'number') {
    if (value === 0) {
      bytes = Buffer.from([0]);
    } else {
      const hex = value.toString(16);
      bytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
    }
  } else {
    bytes = value;
  }
  // Add leading zero if high bit is set (to ensure positive number)
  if (bytes[0] & 0x80) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }
  const lengthBytes = encodeLength(bytes.length);
  return Buffer.concat([Buffer.from([0x02]), lengthBytes, bytes]);
}

function encodeOID(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const bytes: number[] = [];

  // First two components are encoded specially
  bytes.push(parts[0] * 40 + parts[1]);

  // Remaining components use variable-length encoding
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    if (n === 0) {
      bytes.push(0);
    } else {
      const octets: number[] = [];
      while (n > 0) {
        octets.unshift(n & 0x7f);
        n >>= 7;
      }
      for (let j = 0; j < octets.length - 1; j++) {
        octets[j] |= 0x80;
      }
      bytes.push(...octets);
    }
  }

  const content = Buffer.from(bytes);
  const lengthBytes = encodeLength(content.length);
  return Buffer.concat([Buffer.from([0x06]), lengthBytes, content]);
}

function encodePrintableString(str: string): Buffer {
  const content = Buffer.from(str, 'ascii');
  const lengthBytes = encodeLength(content.length);
  return Buffer.concat([Buffer.from([0x13]), lengthBytes, content]);
}

function encodeUTCTime(date: Date): Buffer {
  const year = date.getUTCFullYear() % 100;
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');
  const str = `${year.toString().padStart(2, '0')}${month}${day}${hours}${minutes}${seconds}Z`;
  const content = Buffer.from(str, 'ascii');
  const lengthBytes = encodeLength(content.length);
  return Buffer.concat([Buffer.from([0x17]), lengthBytes, content]);
}

function encodeBitString(data: Buffer): Buffer {
  // Add leading byte for unused bits (0)
  const content = Buffer.concat([Buffer.from([0]), data]);
  const lengthBytes = encodeLength(content.length);
  return Buffer.concat([Buffer.from([0x03]), lengthBytes, content]);
}

function encodeContextTag(tag: number, content: Buffer): Buffer {
  const lengthBytes = encodeLength(content.length);
  return Buffer.concat([Buffer.from([0xa0 | tag]), lengthBytes, content]);
}

function buildTBSCertificate(params: CertParams, pubKeyDer: Buffer): Buffer {
  // Version (v3 = 2)
  const version = encodeContextTag(0, encodeInteger(2));

  // Serial number
  const serial = encodeInteger(Buffer.from(params.serialNumber, 'hex'));

  // Signature algorithm (SHA256 with RSA)
  const signatureAlgorithm = encodeSequence([
    encodeOID('1.2.840.113549.1.1.11'), // sha256WithRSAEncryption
    Buffer.from([0x05, 0x00]) // NULL
  ]);

  // Issuer (same as subject for self-signed)
  const issuer = buildName(params.commonName);

  // Validity
  const validity = encodeSequence([
    encodeUTCTime(params.notBefore),
    encodeUTCTime(params.notAfter)
  ]);

  // Subject
  const subject = buildName(params.commonName);

  // Subject Public Key Info (already in DER format)
  const subjectPublicKeyInfo = pubKeyDer;

  // Extensions (v3)
  const extensions = buildExtensions(params.commonName);
  const extensionsTagged = encodeContextTag(3, extensions);

  return encodeSequence([
    version,
    serial,
    signatureAlgorithm,
    issuer,
    validity,
    subject,
    subjectPublicKeyInfo,
    extensionsTagged
  ]);
}

function buildName(commonName: string): Buffer {
  // Build RDN for CN (Common Name)
  const cnOid = encodeOID('2.5.4.3'); // id-at-commonName
  const cnValue = encodePrintableString(commonName);
  const cnAttr = encodeSequence([cnOid, cnValue]);
  const cnRdn = encodeSet([cnAttr]);

  return encodeSequence([cnRdn]);
}

function buildExtensions(commonName: string): Buffer {
  // Basic Constraints (CA: false)
  const basicConstraints = encodeSequence([
    encodeOID('2.5.29.19'), // id-ce-basicConstraints
    Buffer.from([0x01, 0x01, 0xff]), // critical = true
    Buffer.from([0x04, 0x02, 0x30, 0x00]) // OCTET STRING containing empty SEQUENCE
  ]);

  // Key Usage (digitalSignature, keyEncipherment)
  const keyUsage = encodeSequence([
    encodeOID('2.5.29.15'), // id-ce-keyUsage
    Buffer.from([0x01, 0x01, 0xff]), // critical = true
    Buffer.from([0x04, 0x04, 0x03, 0x02, 0x05, 0xa0]) // OCTET STRING containing BIT STRING
  ]);

  // Subject Alternative Name (DNS name)
  const sanValue = encodeSequence([
    Buffer.concat([
      Buffer.from([0x82]), // context tag 2 (dNSName)
      encodeLength(commonName.length),
      Buffer.from(commonName, 'ascii')
    ])
  ]);
  const sanOctet = Buffer.concat([
    Buffer.from([0x04]),
    encodeLength(sanValue.length),
    sanValue
  ]);
  const san = encodeSequence([
    encodeOID('2.5.29.17'), // id-ce-subjectAltName
    sanOctet
  ]);

  return encodeSequence([basicConstraints, keyUsage, san]);
}

function buildCertificate(tbsCert: Buffer, signature: Buffer): Buffer {
  // Signature algorithm
  const signatureAlgorithm = encodeSequence([
    encodeOID('1.2.840.113549.1.1.11'), // sha256WithRSAEncryption
    Buffer.from([0x05, 0x00]) // NULL
  ]);

  // Signature value
  const signatureValue = encodeBitString(signature);

  return encodeSequence([tbsCert, signatureAlgorithm, signatureValue]);
}
