/**
 * Tests for file access control
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileControl, createFileControl } from '../../../src/permissions/file-control.js';
import type { FilePermissions } from '../../../src/types.js';

describe('FileControl', () => {
  let fileControl: FileControl;
  const homeDir = os.homedir();

  const defaultPermissions: FilePermissions = {
    allowedPaths: [
      `${homeDir}/workspace/**`,
      '/tmp/openclaw/**',
      '/tmp/aquaman/**'
    ],
    deniedPaths: [
      '**/.env',
      '**/.env.*',
      '**/*.pem',
      '**/*.key',
      `${homeDir}/.ssh/**`,
      `${homeDir}/.aws/**`,
      `${homeDir}/.openclaw/auth-profiles.json`
    ],
    sensitivePatterns: [
      '**/credentials*',
      '**/secrets*'
    ]
  };

  beforeEach(() => {
    fileControl = createFileControl({ permissions: defaultPermissions });
  });

  describe('checkAccess', () => {
    describe('allowed paths', () => {
      it('should allow files in workspace', () => {
        const result = fileControl.checkAccess(`${homeDir}/workspace/project/file.ts`, 'read');

        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(false);
      });

      it('should allow files in /tmp/openclaw', () => {
        const result = fileControl.checkAccess('/tmp/openclaw/data.json', 'write');

        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(false);
      });

      it('should allow nested paths in allowed directories', () => {
        const result = fileControl.checkAccess(
          `${homeDir}/workspace/deep/nested/path/file.txt`,
          'read'
        );

        expect(result.allowed).toBe(true);
      });
    });

    describe('denied paths', () => {
      it('should deny .env files', () => {
        const result = fileControl.checkAccess(`${homeDir}/project/.env`, 'read');

        expect(result.allowed).toBe(false);
        expect(result.riskLevel).toBe('critical');
      });

      it('should deny .env.local files', () => {
        const result = fileControl.checkAccess(`${homeDir}/project/.env.local`, 'read');

        expect(result.allowed).toBe(false);
      });

      it('should deny .pem files', () => {
        const result = fileControl.checkAccess('/var/certs/server.pem', 'read');

        expect(result.allowed).toBe(false);
      });

      it('should deny SSH keys', () => {
        const result = fileControl.checkAccess(`${homeDir}/.ssh/id_rsa`, 'read');

        expect(result.allowed).toBe(false);
        expect(result.riskLevel).toBe('critical');
      });

      it('should deny AWS credentials', () => {
        const result = fileControl.checkAccess(`${homeDir}/.aws/credentials`, 'read');

        expect(result.allowed).toBe(false);
      });

      it('should deny OpenClaw auth file', () => {
        const result = fileControl.checkAccess(
          `${homeDir}/.openclaw/auth-profiles.json`,
          'read'
        );

        expect(result.allowed).toBe(false);
      });
    });

    describe('sensitive patterns', () => {
      it('should require approval for credentials files', () => {
        // First add to allowed path
        const fc = createFileControl({
          permissions: {
            allowedPaths: [`${homeDir}/**`],
            deniedPaths: [],
            sensitivePatterns: ['**/credentials*']
          }
        });

        const result = fc.checkAccess(`${homeDir}/app/credentials.json`, 'read');

        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(true);
        expect(result.riskLevel).toBe('high');
      });

      it('should require approval for secrets files', () => {
        const fc = createFileControl({
          permissions: {
            allowedPaths: [`${homeDir}/**`],
            deniedPaths: [],
            sensitivePatterns: ['**/secrets*']
          }
        });

        const result = fc.checkAccess(`${homeDir}/project/secrets.yaml`, 'write');

        expect(result.allowed).toBe(true);
        expect(result.requiresApproval).toBe(true);
      });
    });

    describe('paths not in allowlist', () => {
      it('should deny paths not in allowed directories', () => {
        const result = fileControl.checkAccess('/etc/passwd', 'read');

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('not in any allowed directory');
      });

      it('should deny random paths outside workspace', () => {
        const result = fileControl.checkAccess(`${homeDir}/Downloads/file.txt`, 'read');

        expect(result.allowed).toBe(false);
      });
    });

    describe('operation types', () => {
      it('should have higher risk for write operations', () => {
        const readResult = fileControl.checkAccess(`${homeDir}/workspace/file.ts`, 'read');
        const writeResult = fileControl.checkAccess(`${homeDir}/workspace/file.ts`, 'write');

        expect(readResult.riskLevel).toBe('low');
        expect(writeResult.riskLevel).toBe('medium');
      });
    });
  });

  describe('isCredentialFile', () => {
    it('should identify .env files', () => {
      expect(fileControl.isCredentialFile('/project/.env')).toBe(true);
      expect(fileControl.isCredentialFile('/project/.env.local')).toBe(true);
    });

    it('should identify key files', () => {
      expect(fileControl.isCredentialFile('/certs/server.pem')).toBe(true);
      expect(fileControl.isCredentialFile('/certs/private.key')).toBe(true);
      expect(fileControl.isCredentialFile('/certs/cert.p12')).toBe(true);
    });

    it('should identify SSH keys', () => {
      expect(fileControl.isCredentialFile(`${homeDir}/.ssh/id_rsa`)).toBe(true);
      expect(fileControl.isCredentialFile(`${homeDir}/.ssh/id_ed25519`)).toBe(true);
    });

    it('should identify credentials files', () => {
      expect(fileControl.isCredentialFile('/app/credentials.json')).toBe(true);
      expect(fileControl.isCredentialFile('/config/secrets.yaml')).toBe(true);
    });

    it('should not flag regular files', () => {
      expect(fileControl.isCredentialFile('/project/README.md')).toBe(false);
      expect(fileControl.isCredentialFile('/src/index.ts')).toBe(false);
    });
  });

  describe('path expansion', () => {
    it('should expand ~ to home directory', () => {
      const fc = createFileControl({
        permissions: {
          allowedPaths: ['~/workspace/**'],
          deniedPaths: [],
          sensitivePatterns: []
        }
      });

      const result = fc.checkAccess(`${homeDir}/workspace/file.ts`, 'read');
      expect(result.allowed).toBe(true);
    });

    it('should expand ${HOME}', () => {
      const fc = createFileControl({
        permissions: {
          allowedPaths: ['${HOME}/projects/**'],
          deniedPaths: [],
          sensitivePatterns: []
        }
      });

      const result = fc.checkAccess(`${homeDir}/projects/test.ts`, 'read');
      expect(result.allowed).toBe(true);
    });
  });

  describe('addAllowedPath', () => {
    it('should add new allowed path', () => {
      fileControl.addAllowedPath('/new/allowed/path/**');

      const result = fileControl.checkAccess('/new/allowed/path/file.txt', 'read');
      expect(result.allowed).toBe(true);
    });
  });

  describe('addDeniedPath', () => {
    it('should add new denied path', () => {
      fileControl.addDeniedPath('**/dangerous/**');

      const result = fileControl.checkAccess(`${homeDir}/workspace/dangerous/file.txt`, 'read');
      expect(result.allowed).toBe(false);
    });
  });

  describe('addSensitivePattern', () => {
    it('should add new sensitive pattern', () => {
      fileControl.addSensitivePattern('**/tokens*');

      const fc = createFileControl({
        permissions: {
          allowedPaths: [`${homeDir}/**`],
          deniedPaths: [],
          sensitivePatterns: ['**/tokens*']
        }
      });

      const result = fc.checkAccess(`${homeDir}/app/tokens.json`, 'read');
      expect(result.requiresApproval).toBe(true);
    });
  });

  describe('getPermissions', () => {
    it('should return current permissions', () => {
      const permissions = fileControl.getPermissions();

      expect(permissions.allowedPaths).toHaveLength(3);
      expect(permissions.deniedPaths).toHaveLength(7);
      expect(permissions.sensitivePatterns).toHaveLength(2);
    });
  });
});
