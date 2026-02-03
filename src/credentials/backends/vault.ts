/**
 * HashiCorp Vault credential backend using KV v2 API
 * Requires: Vault server accessible and valid token
 */

import type { CredentialStore } from '../store.js';

export interface VaultStoreOptions {
  address: string;      // https://vault.example.com:8200
  token?: string;       // or uses VAULT_TOKEN env var
  namespace?: string;   // for Vault Enterprise
  mountPath?: string;   // defaults to 'secret'
}

const DEFAULT_MOUNT_PATH = 'secret';
const AQUAMAN_PATH_PREFIX = 'aquaman';

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

  private getPath(service: string, key: string): string {
    return `${AQUAMAN_PATH_PREFIX}/${service}/${key}`;
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
      return `${this.mountPath}/metadata/${AQUAMAN_PATH_PREFIX}/${service}`;
    }
    return `${this.mountPath}/metadata/${AQUAMAN_PATH_PREFIX}`;
  }

  async get(service: string, key: string): Promise<string | null> {
    try {
      const result = await this.request('GET', this.getDataPath(service, key));

      if (result.status === 404) {
        return null;
      }

      // KV v2 wraps data in another data object
      const kvData = result.data as { data?: Record<string, string> };
      return kvData?.data?.credential || null;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
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
    try {
      // For KV v2, we need to delete the metadata to fully remove the secret
      const result = await this.request('DELETE', this.getMetadataPath(service, key));
      return result.status === 204 || result.status === 200;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      throw error;
    }
  }

  async list(service?: string): Promise<Array<{ service: string; key: string }>> {
    const credentials: Array<{ service: string; key: string }> = [];

    try {
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
          const serviceCredentials = await this.list(cleanService);
          credentials.push(...serviceCredentials);
        }
      }

      return credentials;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return [];
      }
      throw error;
    }
  }

  async exists(service: string, key: string): Promise<boolean> {
    const value = await this.get(service, key);
    return value !== null;
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
