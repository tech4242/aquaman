/**
 * aquaman-proxy - Credential isolation proxy daemon for OpenClaw
 *
 * This package provides:
 * - Credential proxy daemon that injects API keys into requests
 * - Service registry for configuring upstream services
 * - OpenClaw integration for environment configuration
 * - CLI for managing the proxy
 */

// Daemon
export {
  type TlsOptions,
  type CredentialProxyOptions,
  type RequestInfo,
  CredentialProxy,
  createCredentialProxy,
  type ServiceDefinition
} from './daemon.js';

// Service Registry
export {
  type AuthMode,
  type OAuthConfig,
  type ServiceRegistryOptions,
  ServiceRegistry,
  createServiceRegistry
} from './service-registry.js';

// OAuth Token Cache
export {
  OAuthTokenCache,
  createOAuthTokenCache
} from './oauth-token-cache.js';

// OpenClaw Integration
export {
  type EnvConfig,
  generateOpenClawEnv,
  writeEnvFile,
  appendToShellRc,
  formatEnvForDisplay
} from './openclaw/env-writer.js';

export {
  type OpenClawInfo,
  type LaunchOptions,
  OpenClawIntegration,
  createOpenClawIntegration
} from './openclaw/integration.js';
