/**
 * Embedded mode - Direct vault access within OpenClaw process
 *
 * This mode provides simpler setup but credentials DO enter the Gateway process memory.
 * Use proxy mode for maximum isolation.
 */

import {
  createCredentialStore,
  createAuditLogger,
  type CredentialStore,
  type AuditLogger,
  type CredentialBackend
} from 'aquaman-core';
import type { PluginConfig } from './config-schema.js';

export interface EmbeddedModeOptions {
  config: PluginConfig;
}

export class EmbeddedMode {
  private config: PluginConfig;
  private store: CredentialStore | null = null;
  private auditLogger: AuditLogger | null = null;
  private initialized = false;

  constructor(options: EmbeddedModeOptions) {
    this.config = options.config;
  }

  /**
   * Initialize the embedded mode
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize credential store
    this.store = createCredentialStore({
      backend: (this.config.backend || 'keychain') as CredentialBackend,
      vaultAddress: this.config.vaultAddress,
      vaultToken: this.config.vaultToken,
      vaultNamespace: this.config.vaultNamespace,
      vaultMountPath: this.config.vaultMountPath,
      onePasswordVault: this.config.onePasswordVault,
      onePasswordAccount: this.config.onePasswordAccount,
      encryptionPassword: this.config.encryptionPassword
    });

    // Initialize audit logger
    if (this.config.auditEnabled !== false) {
      this.auditLogger = createAuditLogger({
        logDir: this.config.auditLogDir || '~/.aquaman/audit',
        enabled: true
      });
      await this.auditLogger.initialize();
    }

    this.initialized = true;
  }

  /**
   * Get a credential for a service
   * WARNING: This retrieves the credential into process memory
   */
  async getCredential(service: string, key: string): Promise<string | null> {
    if (!this.store) {
      throw new Error('Embedded mode not initialized');
    }

    const credential = await this.store.get(service, key);

    // Log access
    if (this.auditLogger) {
      await this.auditLogger.logCredentialAccess('embedded', 'openclaw', {
        service,
        operation: 'read',
        success: credential !== null
      });
    }

    return credential;
  }

  /**
   * Set a credential
   */
  async setCredential(service: string, key: string, value: string): Promise<void> {
    if (!this.store) {
      throw new Error('Embedded mode not initialized');
    }

    await this.store.set(service, key, value);

    // Log access
    if (this.auditLogger) {
      await this.auditLogger.logCredentialAccess('embedded', 'openclaw', {
        service,
        operation: 'use',
        success: true
      });
    }
  }

  /**
   * Delete a credential
   */
  async deleteCredential(service: string, key: string): Promise<boolean> {
    if (!this.store) {
      throw new Error('Embedded mode not initialized');
    }

    return this.store.delete(service, key);
  }

  /**
   * List credentials
   */
  async listCredentials(service?: string): Promise<Array<{ service: string; key: string }>> {
    if (!this.store) {
      throw new Error('Embedded mode not initialized');
    }

    return this.store.list(service);
  }

  /**
   * Check if a credential exists
   */
  async hasCredential(service: string, key: string): Promise<boolean> {
    if (!this.store) {
      throw new Error('Embedded mode not initialized');
    }

    return this.store.exists(service, key);
  }

  /**
   * Get the audit logger
   */
  getAuditLogger(): AuditLogger | null {
    return this.auditLogger;
  }

  /**
   * Get status info
   */
  getStatus(): { initialized: boolean; backend: string; auditEnabled: boolean } {
    return {
      initialized: this.initialized,
      backend: this.config.backend || 'keychain',
      auditEnabled: this.config.auditEnabled !== false
    };
  }

  /**
   * Verify audit log integrity
   */
  async verifyAuditIntegrity(): Promise<{ valid: boolean; errors: string[] }> {
    if (!this.auditLogger) {
      return { valid: true, errors: [] };
    }

    return this.auditLogger.verifyIntegrity();
  }

  /**
   * Get recent audit entries
   */
  async getRecentAuditEntries(count: number = 10): Promise<any[]> {
    if (!this.auditLogger) {
      return [];
    }

    return this.auditLogger.tail(count);
  }
}

export function createEmbeddedMode(options: EmbeddedModeOptions): EmbeddedMode {
  return new EmbeddedMode(options);
}
