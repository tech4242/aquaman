/**
 * Request-level policy enforcement for aquaman proxy
 *
 * Evaluates method + path rules per service before credential injection.
 * Denied requests never get real credentials.
 */

export interface PolicyRule {
  method: string;
  path: string;
  action: 'allow' | 'deny';
}

export interface ServicePolicy {
  defaultAction: 'allow' | 'deny';
  rules: PolicyRule[];
}

export type PolicyConfig = Record<string, ServicePolicy>;

/**
 * Match a glob pattern against a URL path using segment-based matching.
 *
 * - `**` matches zero or more whole path segments
 * - `*` within a segment is a substring wildcard (shell-glob style):
 *   `admin.*` matches `admin.users.list`
 * - An exact segment `foo` matches only `foo`
 */
export function matchPathPattern(pattern: string, urlPath: string): boolean {
  // Normalize: strip leading slash, split on /
  const patternParts = pattern.replace(/^\//, '').replace(/\/$/, '').split('/').filter(Boolean);
  const pathParts = urlPath.replace(/^\//, '').replace(/\/$/, '').split('/').filter(Boolean);

  return matchSegments(patternParts, 0, pathParts, 0);
}

function matchSegments(
  pattern: string[], pi: number,
  path: string[], si: number
): boolean {
  while (pi < pattern.length && si < path.length) {
    const seg = pattern[pi];

    if (seg === '**') {
      // ** matches zero or more whole segments
      // Try matching the rest of pattern against every suffix of path
      for (let skip = si; skip <= path.length; skip++) {
        if (matchSegments(pattern, pi + 1, path, skip)) return true;
      }
      return false;
    }

    // Match single segment (may contain * as substring wildcard)
    if (!matchSegment(seg, path[si])) return false;
    pi++;
    si++;
  }

  // Consume trailing ** patterns (they match zero segments)
  while (pi < pattern.length && pattern[pi] === '**') pi++;

  return pi === pattern.length && si === path.length;
}

function matchSegment(pattern: string, segment: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === segment;

  // Convert segment pattern to regex: * → .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(segment);
}

/**
 * Evaluate policy for a request. Returns whether the request is allowed
 * and the rule that matched (if any).
 *
 * First-match-wins: rules are evaluated top-to-bottom.
 * If no rule matches, defaultAction applies.
 */
export function matchPolicy(
  service: string,
  method: string,
  remainingPath: string,
  config: PolicyConfig
): { allowed: boolean; matchedRule?: PolicyRule } {
  const servicePolicy = config[service];
  if (!servicePolicy) {
    return { allowed: true };
  }

  for (const rule of servicePolicy.rules) {
    const methodMatches = rule.method === '*' || rule.method.toUpperCase() === method.toUpperCase();
    if (!methodMatches) continue;

    if (matchPathPattern(rule.path, remainingPath)) {
      return {
        allowed: rule.action === 'allow',
        matchedRule: rule
      };
    }
  }

  return {
    allowed: servicePolicy.defaultAction === 'allow'
  };
}

/**
 * Extract and return PolicyConfig from a WrapperConfig's policy field.
 * Returns empty config if no policy is set.
 */
export function loadPolicyFromConfig(config: { policy?: Record<string, any> }): PolicyConfig {
  if (!config.policy) return {};

  const result: PolicyConfig = {};
  for (const [service, sp] of Object.entries(config.policy)) {
    result[service] = {
      defaultAction: sp.defaultAction === 'deny' ? 'deny' : 'allow',
      rules: Array.isArray(sp.rules) ? sp.rules.map((r: any) => ({
        method: String(r.method || '*'),
        path: String(r.path || '/'),
        action: r.action === 'allow' ? 'allow' : 'deny'
      })) : []
    };
  }
  return result;
}

/**
 * Validate a PolicyConfig. Returns errors for invalid rules.
 */
export function validatePolicyConfig(policy: PolicyConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [service, sp] of Object.entries(policy)) {
    if (sp.defaultAction !== 'allow' && sp.defaultAction !== 'deny') {
      errors.push(`service "${service}" has invalid defaultAction "${sp.defaultAction}" (expected "allow" or "deny")`);
    }

    for (let i = 0; i < sp.rules.length; i++) {
      const rule = sp.rules[i];
      if (rule.action !== 'allow' && rule.action !== 'deny') {
        errors.push(`rule ${i + 1} for "${service}" has unknown action "${rule.action}" (expected "allow" or "deny")`);
      }
      if (!rule.path.startsWith('/')) {
        errors.push(`rule ${i + 1} for "${service}" has path "${rule.path}" that doesn't start with /`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Default policy presets for common services. Conservative: default-allow
 * with specific denies for dangerous admin/billing/send endpoints.
 */
export function getDefaultPolicyPresets(): Record<string, ServicePolicy> {
  return {
    anthropic: {
      defaultAction: 'allow',
      rules: [
        // Anthropic Admin API: /v1/organizations/{org_id}/... manages API keys, users, workspaces, billing
        { method: '*', path: '/v1/organizations/**', action: 'deny' },
      ]
    },
    openai: {
      defaultAction: 'allow',
      rules: [
        // OpenAI Admin API: /v1/organization/... manages admin keys, users, projects
        { method: '*', path: '/v1/organization/**', action: 'deny' },
        { method: 'DELETE', path: '/v1/**', action: 'deny' },
      ]
    },
    gmail: {
      defaultAction: 'allow',
      rules: [
        // Gmail send. Policy paths are the upstream API's full path after the
        // service prefix, and Gmail's REST path is /gmail/v1/users/{userId}/...
        { method: 'POST', path: '/gmail/v1/users/*/messages/send', action: 'deny' },
        // Pre-0.15.0 form, kept so configs written with it keep matching.
        { method: 'POST', path: '/v1/users/*/messages/send', action: 'deny' },
      ]
    },
    slack: {
      defaultAction: 'allow',
      rules: [
        // Slack admin methods. Real Slack Web API traffic arrives as
        // /api/admin.users.list (the interceptor keeps the full slack.com
        // path; the proxy doesn't prepend the upstream's base path). Through
        // v0.14.x this preset only had '/admin.*', which never matched a
        // working request (verified against slack.com 2026-09-18).
        { method: '*', path: '/api/admin.*', action: 'deny' },
        { method: '*', path: '/admin.*', action: 'deny' },
      ]
    }
  };
}

/**
 * Known-ineffective rule shapes: deny rules written against a path that real
 * upstream traffic never has. Returns human-readable warnings (empty when
 * fine). These came from our own pre-0.15.0 presets, which `aquaman setup`
 * persisted into users' config.yaml, so they outlive the preset fix.
 */
export function lintPolicyConfig(config: PolicyConfig): string[] {
  const warnings: string[] = [];
  const denies = (svc: string) =>
    (config[svc]?.rules ?? []).filter(r => r.action === 'deny').map(r => r.path);

  const slack = denies('slack');
  if (slack.includes('/admin.*') && !slack.some(p => p.startsWith('/api/'))) {
    warnings.push(
      "slack: deny rule '/admin.*' never matches real Slack traffic, which arrives as /api/admin.*. " +
      "Add a rule for path '/api/admin.*' (the v0.15.0 preset has both)."
    );
  }
  const gmail = denies('gmail');
  if (gmail.includes('/v1/users/*/messages/send') && !gmail.some(p => p.startsWith('/gmail/'))) {
    warnings.push(
      "gmail: deny rule '/v1/users/*/messages/send' doesn't match Gmail's real path /gmail/v1/users/*/messages/send. " +
      "Add a rule for that path (the v0.15.0 preset has both)."
    );
  }
  return warnings;
}
