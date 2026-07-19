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
  createOpenClawIntegration,
  parseCalendarVersion,
  authProfilesAreSqliteOnly
} from './openclaw/integration.js';

// OpenClaw SecretRef provider-integration wiring (v0.14.0+)
export {
  type SecretRefRef,
  type SecretRefWiringResult,
  type SecretRefWiringStatus,
  SECRETREF_PLUGIN_ID,
  SECRETREF_INTEGRATION_ID,
  SECRETREF_PROVIDER_ALIAS,
  SECRETREF_SUPPORTED_PROVIDERS,
  supportsSecretRefIntegrations,
  buildProviderRef,
  wireSecretRefProviders,
  secretRefWiringStatus
} from './openclaw/secretref.js';

// Hermes Integration (v0.13.0+)
export {
  type HermesEnvConfig,
  HERMES_SUPPORTED_SERVICES,
  generateHermesEnv,
  hermesWiredServices,
  getHermesEnvPath,
  writeHermesEnv,
  formatHermesEnvForDisplay,
  managedScopeShadowedKeys,
  HERMES_MANAGED_ENV_PATH
} from './hermes/config-writer.js';

export {
  type HermesInfo,
  type HermesIntegrationOptions,
  HermesIntegration,
  createHermesIntegration,
  detectHermes
} from './hermes/integration.js';

// Request Policy
export {
  type PolicyRule,
  type ServicePolicy,
  type PolicyConfig,
  matchPathPattern,
  matchPolicy,
  loadPolicyFromConfig,
  validatePolicyConfig,
  getDefaultPolicyPresets
} from './request-policy.js';

// Core (merged from aquaman-core)
export * from './core/index.js';
