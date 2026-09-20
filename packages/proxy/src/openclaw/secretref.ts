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
 * v0.15.0 also writes `models.providers.<svc>.baseUrl` pointing at aquaman's
 * loopback listener. OpenClaw's model calls go through its own transport with
 * its own undici dispatcher: it ignores the `aquaman.local` sentinel (its DNS
 * lookup fails) and never calls `globalThis.fetch`, so the plugin's
 * interceptor cannot see provider traffic (verified on 2026.7.33 and
 * 2026.9.1). A loopback `baseUrl` is OpenClaw's documented local-provider
 * pattern: the configured `scheme://host:port` origin is trusted for the
 * guarded fetch path, plain HTTP included.
 *
 * The resolver returns the loopback token (falling back to the static
 * `aquaman-proxy-managed` placeholder when no listener is configured); the
 * proxy checks the token, strips it, and injects the real credential
 * upstream. Keys never enter the gateway process — the token is a capability
 * to reach the local proxy, not a credential.
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

/**
 * The URL OpenClaw should call for a provider, given the proxy's loopback
 * origin (`http://127.0.0.1:<port>`). Path shapes match what each provider
 * client appends, exactly as on the Hermes path: the Anthropic client adds
 * `/v1/messages` to `<origin>/anthropic`, and the OpenAI-compatible client
 * adds `/chat/completions` to `<origin>/openai/v1`.
 */
export function loopbackProviderBaseUrl(service: string, origin: string): string | null {
  // Trim trailing slashes without a regex: /\/+$/ backtracks polynomially on
  // an origin ending in many slashes (CodeQL js/polynomial-redos).
  let base = origin;
  while (base.length > 0 && base.endsWith('/')) base = base.slice(0, -1);
  if (service === 'anthropic') return `${base}/anthropic`;
  if (service === 'openai') return `${base}/openai/v1`;
  return null;
}

/** A baseUrl aquaman owns: our loopback shape, or the retired sentinel host. */
function isAquamanBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return (
    /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/(anthropic|openai)(\/v1)?\/?$/.test(value) ||
    /^http:\/\/aquaman\.local\//.test(value)
  );
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
  /** Providers whose baseUrl now points at the loopback listener. */
  baseUrlProviders: string[];
  /** Providers left alone because the user set their own baseUrl. */
  keptUserBaseUrl: string[];
}

export interface SecretRefWiringOptions {
  /** `http://127.0.0.1:<port>` — when given, providers also get a baseUrl. */
  loopbackOrigin?: string;
}

/**
 * Merge the aquaman SecretRef wiring into a parsed openclaw.json object.
 * Mutates `config` in place (mirrors the CLI's existing merge style),
 * idempotent, and never overwrites a provider apiKey the user set to
 * something other than an aquaman ref or the legacy placeholder.
 */
export function wireSecretRefProviders(
  config: Record<string, any>,
  services: string[],
  options: SecretRefWiringOptions = {}
): SecretRefWiringResult {
  let changed = false;
  const wiredProviders: string[] = [];
  const skippedProviders: string[] = [];
  const baseUrlProviders: string[] = [];
  const keptUserBaseUrl: string[] = [];

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

    // Route the provider at the loopback listener. Without this, OpenClaw's
    // transport calls the real upstream directly and the proxy never sees it.
    const desiredBase = options.loopbackOrigin
      ? loopbackProviderBaseUrl(service, options.loopbackOrigin)
      : null;
    if (desiredBase) {
      const currentBase = providerEntry.baseUrl;
      if (currentBase !== undefined && !isAquamanBaseUrl(currentBase)) {
        keptUserBaseUrl.push(service);
      } else {
        if (currentBase !== desiredBase) {
          providerEntry.baseUrl = desiredBase;
          changed = true;
        }
        baseUrlProviders.push(service);
      }
    }
  }

  return { changed, wiredProviders, skippedProviders, baseUrlProviders, keptUserBaseUrl };
}

export interface SecretRefWiringStatus {
  /** secrets.providers.aquaman points at the plugin integration. */
  providerConfigured: boolean;
  /** Providers whose apiKey is an aquaman SecretRef. */
  wiredProviders: string[];
  /** Requested + supported providers not yet wired. */
  missingProviders: string[];
  /** Providers whose baseUrl points at a loopback aquaman listener. */
  baseUrlProviders: string[];
  /** Wired providers still calling the upstream directly (proxy bypassed). */
  missingBaseUrl: string[];
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
  const baseUrlProviders: string[] = [];
  const missingBaseUrl: string[] = [];
  for (const service of services) {
    if (!(SECRETREF_SUPPORTED_PROVIDERS as readonly string[]).includes(service)) continue;
    if (isAquamanRef(config?.models?.providers?.[service]?.apiKey)) {
      wiredProviders.push(service);
      // A wired apiKey with no loopback baseUrl means OpenClaw's transport
      // still calls the upstream directly and the proxy is bypassed.
      if (isAquamanBaseUrl(config?.models?.providers?.[service]?.baseUrl)) {
        baseUrlProviders.push(service);
      } else {
        missingBaseUrl.push(service);
      }
    } else {
      missingProviders.push(service);
    }
  }
  return { providerConfigured, wiredProviders, missingProviders, baseUrlProviders, missingBaseUrl };
}
