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
        // Gmail send: POST /gmail/v1/users/{userId}/messages/send
        { method: 'POST', path: '/v1/users/*/messages/send', action: 'deny' },
      ]
    },
    slack: {
      defaultAction: 'allow',
      rules: [
        // Slack admin methods: /admin.users.list, /admin.conversations.create, etc.
        { method: '*', path: '/admin.*', action: 'deny' },
      ]
    }
  };
}
