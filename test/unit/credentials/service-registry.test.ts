/**
 * Tests for service registry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ServiceRegistry, createServiceRegistry } from '../../../src/credentials/service-registry.js';

describe('ServiceRegistry', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-registry-test-'));
    configPath = path.join(tempDir, 'services.yaml');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Builtin Services', () => {
    it('loads builtin services by default', () => {
      const registry = createServiceRegistry({ configPath });

      expect(registry.has('anthropic')).toBe(true);
      expect(registry.has('openai')).toBe(true);
      expect(registry.has('slack')).toBe(true);
      expect(registry.has('discord')).toBe(true);
      expect(registry.has('github')).toBe(true);
    });

    it('anthropic service has correct configuration', () => {
      const registry = createServiceRegistry({ configPath });
      const service = registry.get('anthropic');

      expect(service).toBeDefined();
      expect(service!.upstream).toBe('https://api.anthropic.com');
      expect(service!.authHeader).toBe('x-api-key');
      expect(service!.credentialKey).toBe('api_key');
      expect(service!.authPrefix).toBeUndefined();
    });

    it('openai service has Bearer prefix', () => {
      const registry = createServiceRegistry({ configPath });
      const service = registry.get('openai');

      expect(service).toBeDefined();
      expect(service!.authPrefix).toBe('Bearer ');
    });

    it('can disable builtin services', () => {
      const registry = createServiceRegistry({
        configPath,
        builtinServices: false
      });

      expect(registry.has('anthropic')).toBe(false);
      expect(registry.has('openai')).toBe(false);
      expect(registry.getAll()).toHaveLength(0);
    });

    it('getBuiltinServiceNames returns correct list', () => {
      const names = ServiceRegistry.getBuiltinServiceNames();

      expect(names).toContain('anthropic');
      expect(names).toContain('openai');
      expect(names).toContain('slack');
      expect(names).toContain('discord');
      expect(names).toContain('github');
    });
  });

  describe('Custom Services from YAML', () => {
    it('loads custom services from YAML', () => {
      const yaml = `
services:
  - name: custom-api
    upstream: https://api.custom.com
    authHeader: X-API-Key
    credentialKey: api_key
    description: Custom API service
`;
      fs.writeFileSync(configPath, yaml);

      const registry = createServiceRegistry({ configPath });

      expect(registry.has('custom-api')).toBe(true);
      const service = registry.get('custom-api');
      expect(service!.upstream).toBe('https://api.custom.com');
      expect(service!.authHeader).toBe('X-API-Key');
      expect(service!.description).toBe('Custom API service');
    });

    it('custom services override builtins', () => {
      const yaml = `
services:
  - name: anthropic
    upstream: https://custom.anthropic.proxy.com
    authHeader: X-Custom-Key
    credentialKey: custom_key
`;
      fs.writeFileSync(configPath, yaml);

      const registry = createServiceRegistry({ configPath });

      const service = registry.get('anthropic');
      expect(service!.upstream).toBe('https://custom.anthropic.proxy.com');
      expect(service!.authHeader).toBe('X-Custom-Key');
      expect(service!.credentialKey).toBe('custom_key');
    });

    it('handles authPrefix in custom services', () => {
      const yaml = `
services:
  - name: my-api
    upstream: https://api.example.com
    authHeader: Authorization
    authPrefix: "Token "
    credentialKey: token
`;
      fs.writeFileSync(configPath, yaml);

      const registry = createServiceRegistry({ configPath });

      const service = registry.get('my-api');
      expect(service!.authPrefix).toBe('Token ');
    });
  });

  describe('Validation', () => {
    it('validates required fields', () => {
      const registry = createServiceRegistry({ configPath, builtinServices: false });

      expect(registry.validateService({}).valid).toBe(false);
      expect(registry.validateService({ name: 'test' }).valid).toBe(false);
      expect(registry.validateService({ name: 'test', upstream: 'http://api.com' }).valid).toBe(false);
    });

    it('rejects invalid upstream URLs', () => {
      const registry = createServiceRegistry({ configPath, builtinServices: false });

      expect(registry.validateService({
        name: 'test',
        upstream: 'not-a-url',
        authHeader: 'Authorization',
        credentialKey: 'key'
      }).valid).toBe(false);

      expect(registry.validateService({
        name: 'test',
        upstream: 'ftp://files.example.com',
        authHeader: 'Authorization',
        credentialKey: 'key'
      }).valid).toBe(false);
    });

    it('accepts valid service definition', () => {
      const registry = createServiceRegistry({ configPath, builtinServices: false });

      const result = registry.validateService({
        name: 'valid-service',
        upstream: 'https://api.example.com',
        authHeader: 'Authorization',
        credentialKey: 'api_key'
      });

      expect(result.valid).toBe(true);
    });

    it('validates config file and reports errors', () => {
      const yaml = `
services:
  - name: valid
    upstream: https://api.example.com
    authHeader: Authorization
    credentialKey: key
  - name: invalid
    upstream: not-a-url
    authHeader: X-Key
    credentialKey: key
`;
      fs.writeFileSync(configPath, yaml);

      const result = ServiceRegistry.validateConfigFile(configPath);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('Service 2'))).toBe(true);
    });

    it('detects duplicate service names', () => {
      const yaml = `
services:
  - name: my-api
    upstream: https://api1.example.com
    authHeader: Authorization
    credentialKey: key
  - name: my-api
    upstream: https://api2.example.com
    authHeader: Authorization
    credentialKey: key
`;
      fs.writeFileSync(configPath, yaml);

      const result = ServiceRegistry.validateConfigFile(configPath);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('duplicate'))).toBe(true);
    });
  });

  describe('Registry Methods', () => {
    it('getAll returns all services', () => {
      const registry = createServiceRegistry({ configPath });
      const all = registry.getAll();

      expect(all.length).toBeGreaterThanOrEqual(5);
      expect(all.some(s => s.name === 'anthropic')).toBe(true);
    });

    it('getNames returns service names', () => {
      const registry = createServiceRegistry({ configPath });
      const names = registry.getNames();

      expect(names).toContain('anthropic');
      expect(names).toContain('openai');
    });

    it('has returns false for non-existent service', () => {
      const registry = createServiceRegistry({ configPath });

      expect(registry.has('nonexistent')).toBe(false);
    });

    it('get returns undefined for non-existent service', () => {
      const registry = createServiceRegistry({ configPath });

      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('toConfigMap returns backwards-compatible format', () => {
      const registry = createServiceRegistry({ configPath });
      const configMap = registry.toConfigMap();

      expect(configMap['anthropic']).toBeDefined();
      expect(configMap['anthropic'].upstream).toBe('https://api.anthropic.com');
      expect(configMap['anthropic'].authHeader).toBe('x-api-key');
      expect(configMap['anthropic'].credentialKey).toBe('api_key');
    });

    it('reload refreshes from config file', () => {
      // Start with no custom config
      const registry = createServiceRegistry({ configPath });
      expect(registry.has('new-service')).toBe(false);

      // Add custom service to config
      const yaml = `
services:
  - name: new-service
    upstream: https://new.api.com
    authHeader: X-Key
    credentialKey: key
`;
      fs.writeFileSync(configPath, yaml);

      // Reload
      registry.reload();

      expect(registry.has('new-service')).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('handles missing config file gracefully', () => {
      const registry = createServiceRegistry({
        configPath: '/nonexistent/path/services.yaml'
      });

      // Should still have builtin services
      expect(registry.has('anthropic')).toBe(true);
    });

    it('handles malformed YAML gracefully', () => {
      fs.writeFileSync(configPath, 'this is not: valid: yaml: [');

      // Should log error but not crash
      const registry = createServiceRegistry({ configPath });

      // Should still have builtin services
      expect(registry.has('anthropic')).toBe(true);
    });

    it('skips invalid services in config', () => {
      const yaml = `
services:
  - name: valid-service
    upstream: https://valid.api.com
    authHeader: Authorization
    credentialKey: key
  - name: invalid-missing-upstream
    authHeader: Authorization
    credentialKey: key
`;
      fs.writeFileSync(configPath, yaml);

      const registry = createServiceRegistry({ configPath });

      expect(registry.has('valid-service')).toBe(true);
      expect(registry.has('invalid-missing-upstream')).toBe(false);
    });
  });
});
