/**
 * File access control - path allowlist/denylist enforcement
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { minimatch } from 'minimatch';
import type { FilePermissions, RiskLevel } from '../types.js';

export interface FileAccessResult {
  allowed: boolean;
  reason: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

export interface FileControlOptions {
  permissions: FilePermissions;
}

export class FileControl {
  private allowedPaths: string[];
  private deniedPaths: string[];
  private sensitivePatterns: string[];

  constructor(options: FileControlOptions) {
    this.allowedPaths = options.permissions.allowedPaths.map(p => this.expandPath(p));
    this.deniedPaths = options.permissions.deniedPaths.map(p => this.expandPath(p));
    this.sensitivePatterns = options.permissions.sensitivePatterns.map(p => this.expandPath(p));
  }

  private expandPath(p: string): string {
    if (p.startsWith('~')) {
      return path.join(os.homedir(), p.slice(1));
    }
    if (p.includes('${HOME}')) {
      return p.replace(/\$\{HOME\}/g, os.homedir());
    }
    return p;
  }

  checkAccess(filePath: string, operation: 'read' | 'write'): FileAccessResult {
    const normalizedPath = this.normalizePath(filePath);

    // Check denied paths first (highest priority)
    for (const pattern of this.deniedPaths) {
      if (this.matchesPattern(normalizedPath, pattern)) {
        return {
          allowed: false,
          reason: `Path matches denied pattern: ${pattern}`,
          riskLevel: 'critical',
          requiresApproval: false
        };
      }
    }

    // Check sensitive patterns (require approval)
    for (const pattern of this.sensitivePatterns) {
      if (this.matchesPattern(normalizedPath, pattern)) {
        return {
          allowed: true,
          reason: `Path matches sensitive pattern: ${pattern}`,
          riskLevel: 'high',
          requiresApproval: true
        };
      }
    }

    // Check allowed paths
    const inAllowedPath = this.allowedPaths.some(pattern =>
      this.matchesPattern(normalizedPath, pattern)
    );

    if (inAllowedPath) {
      return {
        allowed: true,
        reason: 'Path is in allowed directory',
        riskLevel: operation === 'write' ? 'medium' : 'low',
        requiresApproval: false
      };
    }

    // Default: deny if not in allowed paths
    return {
      allowed: false,
      reason: 'Path is not in any allowed directory',
      riskLevel: 'high',
      requiresApproval: false
    };
  }

  private normalizePath(filePath: string): string {
    let normalized = this.expandPath(filePath);

    // Resolve to absolute path
    if (!path.isAbsolute(normalized)) {
      normalized = path.resolve(normalized);
    }

    // Resolve symlinks and .. components
    return path.normalize(normalized);
  }

  private matchesPattern(filePath: string, pattern: string): boolean {
    // Handle glob patterns
    if (pattern.includes('*') || pattern.includes('?')) {
      return minimatch(filePath, pattern, { dot: true });
    }

    // Handle exact matches and directory prefixes
    if (pattern.endsWith('/**')) {
      const dirPath = pattern.slice(0, -3);
      return filePath.startsWith(dirPath);
    }

    return filePath === pattern || filePath.startsWith(pattern + path.sep);
  }

  isCredentialFile(filePath: string): boolean {
    const normalizedPath = this.normalizePath(filePath);
    const credentialPatterns = [
      '**/.env',
      '**/.env.*',
      '**/credentials*',
      '**/secrets*',
      '**/*.pem',
      '**/*.key',
      '**/*.p12',
      '**/*_rsa',
      '**/*_dsa',
      '**/*_ecdsa',
      '**/*_ed25519',
      `${os.homedir()}/.ssh/**`,
      `${os.homedir()}/.aws/**`,
      `${os.homedir()}/.gnupg/**`,
      `${os.homedir()}/.openclaw/auth-profiles.json`
    ];

    return credentialPatterns.some(pattern =>
      this.matchesPattern(normalizedPath, this.expandPath(pattern))
    );
  }

  addAllowedPath(pattern: string): void {
    this.allowedPaths.push(this.expandPath(pattern));
  }

  addDeniedPath(pattern: string): void {
    this.deniedPaths.push(this.expandPath(pattern));
  }

  addSensitivePattern(pattern: string): void {
    this.sensitivePatterns.push(this.expandPath(pattern));
  }

  getPermissions(): FilePermissions {
    return {
      allowedPaths: [...this.allowedPaths],
      deniedPaths: [...this.deniedPaths],
      sensitivePatterns: [...this.sensitivePatterns]
    };
  }
}

export function createFileControl(options: FileControlOptions): FileControl {
  return new FileControl(options);
}
