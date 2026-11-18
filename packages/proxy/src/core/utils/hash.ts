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

/** The GCM authentication tag is always the full 128 bits, written and read. */
const GCM_TAG_BYTES = 16;

export function encryptWithPassword(data: string, password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 600000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });

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
  // Node accepts GCM tags as short as 4 bytes unless told otherwise, and a
  // short tag is one that can be forged by trial. Checked before the key is
  // derived, so a file with a cut-down tag costs nothing to refuse.
  if (authTag.length !== GCM_TAG_BYTES) {
    throw new Error('Invalid encrypted data format: the authentication tag is not 128 bits');
  }
  const key = crypto.pbkdf2Sync(password, salt, 600000, 32, 'sha256');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'base64', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}
