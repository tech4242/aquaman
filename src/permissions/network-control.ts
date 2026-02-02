/**
 * Network egress control - domain and port filtering
 */

import type { NetworkPermissions, RiskLevel } from '../types.js';

export interface NetworkCheckResult {
  allowed: boolean;
  reason: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

export interface NetworkControlOptions {
  permissions: NetworkPermissions;
}

export class NetworkControl {
  private defaultAction: 'allow' | 'deny';
  private allowedDomains: string[];
  private deniedDomains: string[];
  private deniedPorts: number[];

  constructor(options: NetworkControlOptions) {
    this.defaultAction = options.permissions.defaultAction;
    this.allowedDomains = options.permissions.allowedDomains;
    this.deniedDomains = options.permissions.deniedDomains;
    this.deniedPorts = options.permissions.deniedPorts;
  }

  checkUrl(url: string): NetworkCheckResult {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        allowed: false,
        reason: 'Invalid URL format',
        riskLevel: 'medium',
        requiresApproval: false
      };
    }

    const hostname = parsed.hostname;
    const port = this.extractPort(parsed);

    return this.checkHostPort(hostname, port);
  }

  checkHostPort(hostname: string, port?: number): NetworkCheckResult {
    // Check denied ports first
    if (port !== undefined && this.deniedPorts.includes(port)) {
      return {
        allowed: false,
        reason: `Port ${port} is explicitly denied`,
        riskLevel: 'high',
        requiresApproval: false
      };
    }

    // Check denied domains (explicit deny takes priority)
    if (this.matchesDomainList(hostname, this.deniedDomains)) {
      return {
        allowed: false,
        reason: `Domain ${hostname} is explicitly denied`,
        riskLevel: 'critical',
        requiresApproval: false
      };
    }

    // Check allowed domains
    if (this.matchesDomainList(hostname, this.allowedDomains)) {
      return {
        allowed: true,
        reason: `Domain ${hostname} is in allowlist`,
        riskLevel: 'low',
        requiresApproval: false
      };
    }

    // Apply default action
    if (this.defaultAction === 'allow') {
      return {
        allowed: true,
        reason: 'Domain not in any list, default allow',
        riskLevel: 'medium',
        requiresApproval: false
      };
    }

    // Default deny - require approval for unknown domains
    return {
      allowed: false,
      reason: `Domain ${hostname} not in allowlist`,
      riskLevel: 'medium',
      requiresApproval: true
    };
  }

  private extractPort(url: URL): number | undefined {
    if (url.port) {
      return parseInt(url.port, 10);
    }

    // Default ports
    if (url.protocol === 'https:') return 443;
    if (url.protocol === 'http:') return 80;
    if (url.protocol === 'ws:') return 80;
    if (url.protocol === 'wss:') return 443;

    return undefined;
  }

  private matchesDomainList(hostname: string, patterns: string[]): boolean {
    const normalizedHost = hostname.toLowerCase();

    for (const pattern of patterns) {
      if (this.matchesDomainPattern(normalizedHost, pattern.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  private matchesDomainPattern(hostname: string, pattern: string): boolean {
    // Exact match
    if (hostname === pattern) {
      return true;
    }

    // Wildcard match (*.example.com)
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // Keep the dot: .example.com
      return hostname.endsWith(suffix) || hostname === pattern.slice(2);
    }

    // Subdomain match (pattern matches hostname or any subdomain)
    if (hostname.endsWith('.' + pattern)) {
      return true;
    }

    return false;
  }

  isInternalAddress(hostname: string): boolean {
    const internalPatterns = [
      'localhost',
      '127.0.0.1',
      '::1',
      '0.0.0.0',
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /\.local$/,
      /\.internal$/
    ];

    const normalizedHost = hostname.toLowerCase();

    return internalPatterns.some(pattern => {
      if (typeof pattern === 'string') {
        return normalizedHost === pattern;
      }
      return pattern.test(normalizedHost);
    });
  }

  isSuspiciousDomain(hostname: string): { suspicious: boolean; reason?: string } {
    const normalizedHost = hostname.toLowerCase();

    // Check for IP address URLs (potential SSRF)
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalizedHost)) {
      return { suspicious: true, reason: 'Direct IP address access' };
    }

    // Check for unusual TLDs
    const suspiciousTlds = ['.onion', '.bit', '.i2p'];
    if (suspiciousTlds.some(tld => normalizedHost.endsWith(tld))) {
      return { suspicious: true, reason: 'Suspicious TLD' };
    }

    // Check for homoglyph attacks (very basic)
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(hostname)) {
      return { suspicious: true, reason: 'Non-ASCII characters in domain' };
    }

    // Check for extremely long domains
    if (hostname.length > 253) {
      return { suspicious: true, reason: 'Domain name too long' };
    }

    return { suspicious: false };
  }

  addAllowedDomain(domain: string): void {
    this.allowedDomains.push(domain);
  }

  addDeniedDomain(domain: string): void {
    this.deniedDomains.push(domain);
  }

  addDeniedPort(port: number): void {
    this.deniedPorts.push(port);
  }

  getPermissions(): NetworkPermissions {
    return {
      defaultAction: this.defaultAction,
      allowedDomains: [...this.allowedDomains],
      deniedDomains: [...this.deniedDomains],
      deniedPorts: [...this.deniedPorts]
    };
  }
}

export function createNetworkControl(options: NetworkControlOptions): NetworkControl {
  return new NetworkControl(options);
}
