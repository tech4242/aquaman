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
