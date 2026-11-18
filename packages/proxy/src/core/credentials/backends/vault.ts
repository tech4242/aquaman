/**
 * HashiCorp Vault credential backend using KV v2 API
 * Requires: Vault server accessible and valid token
 */

import type { CredentialStore } from '../store.js';
import type { ParsedLocator } from '../links.js';

export interface VaultStoreOptions {
  address: string;      // https://vault.example.com:8200
  token?: string;       // or uses VAULT_TOKEN env var
  namespace?: string;   // for Vault Enterprise
  mountPath?: string;   // defaults to 'secret'
}

const DEFAULT_MOUNT_PATH = 'secret';
const AQUAMAN_PATH_PREFIX = 'aquaman';
const SAFE_CRED_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export class VaultStore implements CredentialStore {
  private address: string;
  private token: string;
  private namespace?: string;
  private mountPath: string;

  constructor(options: VaultStoreOptions) {
    this.address = options.address.replace(/\/$/, ''); // Remove trailing slash
    this.token = options.token || process.env['VAULT_TOKEN'] || '';
    this.namespace = options.namespace || process.env['VAULT_NAMESPACE'];
    this.mountPath = options.mountPath || DEFAULT_MOUNT_PATH;

    if (!this.token) {
      throw new Error('Vault token required. Provide via options.token or VAULT_TOKEN env var.');
    }

    if (!this.address) {
      throw new Error('Vault address required. Provide via options.address or VAULT_ADDR env var.');
    }
  }

  private validateName(label: string, value: string): void {
    if (!SAFE_CRED_NAME.test(value)) {
      throw new Error(`Invalid ${label} name: "${value}". Allowed pattern: ${SAFE_CRED_NAME.source}`);
    }
  }

  private getPath(service: string, key: string): string {
    this.validateName('service', service);
    this.validateName('key', key);
    return `${AQUAMAN_PATH_PREFIX}/${encodeURIComponent(service)}/${encodeURIComponent(key)}`;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Vault-Token': this.token,
      'Content-Type': 'application/json'
    };

    if (this.namespace) {
      headers['X-Vault-Namespace'] = this.namespace;
    }

    return headers;
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ data?: Record<string, unknown>; status: number }> {
    const url = `${this.address}/v1/${path}`;
    const headers = this.getHeaders();

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 404) {
      return { status: 404 };
    }

    if (!response.ok && response.status !== 204) {
      const errorText = await response.text();
      throw new Error(`Vault API error (${response.status}): ${errorText}`);
    }

    if (response.status === 204) {
      return { status: 204 };
    }

    const data = await response.json() as { data?: Record<string, unknown> };
    return { data: data.data, status: response.status };
  }

  /**
   * KV v2 uses data/ prefix for read/write and metadata/ prefix for metadata
   */
  private getDataPath(service: string, key: string): string {
    return `${this.mountPath}/data/${this.getPath(service, key)}`;
  }

  private getMetadataPath(service: string, key: string): string {
    return `${this.mountPath}/metadata/${this.getPath(service, key)}`;
  }

  private getListPath(service?: string): string {
    if (service) {
      // A name becomes a path segment of the request to Vault, so it is checked here as on every other path.
      this.validateName('service', service);
      return `${this.mountPath}/metadata/${AQUAMAN_PATH_PREFIX}/${encodeURIComponent(service)}`;
    }
    return `${this.mountPath}/metadata/${AQUAMAN_PATH_PREFIX}`;
  }

  async get(service: string, key: string): Promise<string | null> {
    // request() reports a 404 status as { status: 404 }. Any other failure
    // throws and is passed on: "not stored" must never stand in for an error.
    const result = await this.request('GET', this.getDataPath(service, key));

    if (result.status === 404) {
      return null;
    }

    // KV v2 wraps data in another data object
    const kvData = result.data as { data?: Record<string, string> };
    return kvData?.data?.credential || null;
  }

  async set(
    service: string,
    key: string,
    value: string,
    metadata?: Record<string, string>
  ): Promise<void> {
    const data: Record<string, string> = {
      credential: value
    };

    // Add metadata to the secret data (Vault stores metadata separately but we can include it in data too)
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        data[`meta_${k}`] = v;
      }
    }

    await this.request('POST', this.getDataPath(service, key), {
      data
    });
  }

  async delete(service: string, key: string): Promise<boolean> {
    // For KV v2, we need to delete the metadata to fully remove the secret
    const result = await this.request('DELETE', this.getMetadataPath(service, key));
    return result.status === 204 || result.status === 200;
  }

  async list(service?: string): Promise<Array<{ service: string; key: string }>> {
    const credentials: Array<{ service: string; key: string }> = [];

    if (service) {
      // List keys for a specific service
      const result = await this.request('LIST', this.getListPath(service));
      if (result.status === 404) {
        return [];
      }

      const keys = (result.data as { keys?: string[] })?.keys || [];
      for (const key of keys) {
        // Remove trailing slash if present (indicates directory)
        const cleanKey = key.replace(/\/$/, '');
        credentials.push({ service, key: cleanKey });
      }
    } else {
      // List all services first, then keys for each
      const servicesResult = await this.request('LIST', this.getListPath());
      if (servicesResult.status === 404) {
        return [];
      }

      const services = (servicesResult.data as { keys?: string[] })?.keys || [];

      for (const svc of services) {
        const cleanService = svc.replace(/\/$/, '');
        // Anything under the prefix that is not a name aquaman could have written is not ours to list.
        if (!SAFE_CRED_NAME.test(cleanService)) continue;
        const serviceCredentials = await this.list(cleanService);
        credentials.push(...serviceCredentials);
      }
    }

    return credentials;
  }

  async exists(service: string, key: string): Promise<boolean> {
    const value = await this.get(service, key);
    return value !== null;
  }

  /**
   * A KV v2 secret aquaman did not write: one string field of the secret at
   * `<mount>/<path>`. Each part is encoded as one URL segment.
   */
  async readLinked(locator: ParsedLocator): Promise<string | null> {
    // What sits under aquaman's prefix on its own mount is what it wrote. Those
    // are reached by their own reference, never under a second name.
    const own = [...this.mountPath.split('/'), AQUAMAN_PATH_PREFIX];
    if (own.every((part, i) => locator.path[i] === part) && locator.mountParts === own.length - 1) {
      throw new Error(`${locator.text} names an item aquaman itself wrote; use that credential by its own reference`);
    }
    const segments = locator.path.map((p) => encodeURIComponent(p));
    const mount = segments.slice(0, locator.mountParts).join('/');
    const secret = segments.slice(locator.mountParts).join('/');
    const result = await this.request('GET', `${mount}/data/${secret}`);
    if (result.status === 404) {
      return null;
    }
    const fields = (result.data as { data?: Record<string, unknown> } | undefined)?.data;
    if (!fields || !Object.hasOwn(fields, locator.field)) {
      return null;
    }
    const value = fields[locator.field];
    if (typeof value !== 'string') {
      throw new Error(`Field "${locator.field}" of ${locator.text} is not a string`);
    }
    return value.length > 0 ? value : null;
  }

  /**
   * Get the Vault address being used
   */
  getAddress(): string {
    return this.address;
  }

  /**
   * Get the mount path being used
   */
  getMountPath(): string {
    return this.mountPath;
  }

  /**
   * Check if Vault is reachable and token is valid
   */
  async healthCheck(): Promise<{ healthy: boolean; error?: string }> {
    try {
      // Check token validity by looking up self
      const response = await fetch(`${this.address}/v1/auth/token/lookup-self`, {
        headers: this.getHeaders()
      });

      if (response.ok) {
        return { healthy: true };
      }

      return { healthy: false, error: `Token lookup failed: ${response.status}` };
    } catch (error) {
      return { healthy: false, error: `Connection failed: ${error}` };
    }
  }

  /**
   * Check if Vault is available with given options
   */
  static async isAvailable(options: VaultStoreOptions): Promise<boolean> {
    try {
      const store = new VaultStore(options);
      const health = await store.healthCheck();
      return health.healthy;
    } catch {
      return false;
    }
  }
}

export function createVaultStore(options: VaultStoreOptions): VaultStore {
  return new VaultStore(options);
}
