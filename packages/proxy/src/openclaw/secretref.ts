/**
 * OpenClaw SecretRef provider-integration wiring (v0.14.0+).
 *
 * OpenClaw's canonical credential surface is the SecretRef (upstream
 * openclaw/openclaw#82326, shipped 2026-05-29; docs call auth-profiles.json
 * "not a runtime format"). The aquaman plugin declares a
 * `secretProviderIntegrations.aquaman` exec resolver in its manifest
 * (`packages/plugin/openclaw.plugin.json` → `dist/secrets-resolver.mjs`),
 * and this module writes the config side into `~/.openclaw/openclaw.json`:
 *
 *   secrets.providers.aquaman = {
 *     source: "exec",
 *     pluginIntegration: { pluginId: "aquaman-plugin", integrationId: "aquaman" }
 *   }
 *   models.providers.<svc>.apiKey = { source: "exec", provider: "aquaman", id: "<svc>/api_key" }
 *
 * Config-level refs are used deliberately instead of auth-profile
 * keyRef/tokenRef: openclaw.json is runtime-read on every version, so this
 * avoids the SQLite ingestion step (`openclaw doctor --fix`) that the legacy
 * placeholder flow requires on ≥ 2026.6.5 — and SecretRefs survive the
 * configure-flow scrubs (`scrubAuthProfilesForProviderTargets` deletes
 * plaintext keys but preserves valid refs).
 *
 * The resolver returns the static `aquaman-proxy-managed` placeholder; the
 * proxy strips whatever key the gateway presents and injects the real
 * credential upstream. Keys never enter the gateway process — the SecretRef
 * integration changes how the *placeholder* reaches the gateway, not the
 * isolation boundary.
 */

import { parseCalendarVersion } from './integration.js';

export const SECRETREF_PLUGIN_ID = 'aquaman-plugin';
export const SECRETREF_INTEGRATION_ID = 'aquaman';
export const SECRETREF_PROVIDER_ALIAS = 'aquaman';

/** Providers the exec resolver serves refs for today. */
export const SECRETREF_SUPPORTED_PROVIDERS = ['anthropic', 'openai'] as const;

/**
 * SecretRef provider integrations shipped with the 2026.6.x line (merged
 * upstream 2026-05-29). 2026.6.5 is the safe floor — it is also the
 * auth-profiles→SQLite boundary (`authProfilesAreSqliteOnly`), so on every
 * version where the legacy JSON placeholder stopped being runtime-read,
 * SecretRef wiring is available as the replacement. Unknown/unparseable
 * versions return false (conservative: keep the legacy flow).
 */
export function supportsSecretRefIntegrations(version: string | undefined | null): boolean {
  const parts = parseCalendarVersion(version);
  if (!parts) return false;
  const [y, m, d] = parts;
  if (y !== 2026) return y > 2026;
  if (m !== 6) return m > 6;
  return d >= 5;
}

export interface SecretRefRef {
  source: 'exec';
  provider: string;
  id: string;
}

export function buildProviderRef(service: string): SecretRefRef {
  return { source: 'exec', provider: SECRETREF_PROVIDER_ALIAS, id: `${service}/api_key` };
}

function isAquamanRef(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as SecretRefRef).source === 'exec' &&
    (value as SecretRefRef).provider === SECRETREF_PROVIDER_ALIAS
  );
}

export interface SecretRefWiringResult {
  changed: boolean;
  /** Providers whose apiKey now points at the aquaman SecretRef. */
  wiredProviders: string[];
  /** Providers requested but skipped (unsupported by the resolver today). */
  skippedProviders: string[];
}

/**
 * Merge the aquaman SecretRef wiring into a parsed openclaw.json object.
 * Mutates `config` in place (mirrors the CLI's existing merge style),
 * idempotent, and never overwrites a provider apiKey the user set to
 * something other than an aquaman ref or the legacy placeholder.
 */
export function wireSecretRefProviders(
  config: Record<string, any>,
  services: string[]
): SecretRefWiringResult {
  let changed = false;
  const wiredProviders: string[] = [];
  const skippedProviders: string[] = [];

  if (!config.secrets) config.secrets = {};
  if (!config.secrets.providers) config.secrets.providers = {};
  const desiredProvider = {
    source: 'exec',
    pluginIntegration: {
      pluginId: SECRETREF_PLUGIN_ID,
      integrationId: SECRETREF_INTEGRATION_ID,
    },
  };
  const existingProvider = config.secrets.providers[SECRETREF_PROVIDER_ALIAS];
  if (JSON.stringify(existingProvider) !== JSON.stringify(desiredProvider)) {
    config.secrets.providers[SECRETREF_PROVIDER_ALIAS] = desiredProvider;
    changed = true;
  }

  for (const service of services) {
    if (!(SECRETREF_SUPPORTED_PROVIDERS as readonly string[]).includes(service)) {
      skippedProviders.push(service);
      continue;
    }
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    if (!config.models.providers[service]) config.models.providers[service] = {};

    const providerEntry = config.models.providers[service];
    const desiredRef = buildProviderRef(service);
    const current = providerEntry.apiKey;

    const isLegacyPlaceholder = current === 'aquaman-proxy-managed';
    const isUserValue =
      current !== undefined && !isLegacyPlaceholder && !isAquamanRef(current);

    if (isUserValue) {
      // A key the user set themselves — never clobber it.
      skippedProviders.push(service);
      continue;
    }
    if (JSON.stringify(current) !== JSON.stringify(desiredRef)) {
      providerEntry.apiKey = desiredRef;
      changed = true;
    }
    wiredProviders.push(service);
  }

  return { changed, wiredProviders, skippedProviders };
}

export interface SecretRefWiringStatus {
  /** secrets.providers.aquaman points at the plugin integration. */
  providerConfigured: boolean;
  /** Providers whose apiKey is an aquaman SecretRef. */
  wiredProviders: string[];
  /** Requested + supported providers not yet wired. */
  missingProviders: string[];
}

/** Read-only status check for `aquaman openclaw doctor`. */
export function secretRefWiringStatus(
  config: Record<string, any>,
  services: string[]
): SecretRefWiringStatus {
  const provider = config?.secrets?.providers?.[SECRETREF_PROVIDER_ALIAS];
  const providerConfigured =
    provider?.source === 'exec' &&
    provider?.pluginIntegration?.pluginId === SECRETREF_PLUGIN_ID &&
    provider?.pluginIntegration?.integrationId === SECRETREF_INTEGRATION_ID;

  const wiredProviders: string[] = [];
  const missingProviders: string[] = [];
  for (const service of services) {
    if (!(SECRETREF_SUPPORTED_PROVIDERS as readonly string[]).includes(service)) continue;
    if (isAquamanRef(config?.models?.providers?.[service]?.apiKey)) {
      wiredProviders.push(service);
    } else {
      missingProviders.push(service);
    }
  }
  return { providerConfigured, wiredProviders, missingProviders };
}
