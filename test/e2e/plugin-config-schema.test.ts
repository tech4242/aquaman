/**
 * E2E tests for plugin config schema validation
 *
 * Verifies that openclaw.plugin.json enforces additionalProperties: false
 * and only accepts the 4 documented config keys.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv from 'ajv';

const MANIFEST_PATH = path.resolve(__dirname, '../../packages/openclaw/openclaw.plugin.json');

describe('Plugin Config Schema', () => {
  let manifest: any;
  let validate: any;

  it('should load the plugin manifest', () => {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    manifest = JSON.parse(raw);

    expect(manifest.id).toBe('aquaman');
    expect(manifest.name).toBe('Aquaman Vault');
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.additionalProperties).toBe(false);
  });

  it('should accept config with only the 4 allowed keys', () => {
    const ajv = new Ajv();
    validate = ajv.compile(manifest.configSchema);

    const validConfig = {
      mode: 'proxy',
      backend: 'keychain',
      services: ['anthropic', 'openai'],
      proxyPort: 8081
    };

    const valid = validate(validConfig);
    expect(valid).toBe(true);
  });

  it('should accept config with defaults (empty object)', () => {
    const valid = validate({});
    expect(valid).toBe(true);
  });

  it('should accept partial config', () => {
    expect(validate({ mode: 'embedded' })).toBe(true);
    expect(validate({ backend: 'vault' })).toBe(true);
    expect(validate({ services: ['anthropic'] })).toBe(true);
    expect(validate({ proxyPort: 9090 })).toBe(true);
  });

  it('should reject config with extra keys', () => {
    const invalid = validate({
      mode: 'proxy',
      tlsEnabled: true  // not in schema
    });
    expect(invalid).toBe(false);
  });

  it('should reject proxyAutoStart (common mistake)', () => {
    const invalid = validate({
      proxyAutoStart: true
    });
    expect(invalid).toBe(false);
  });

  it('should reject auditEnabled (common mistake)', () => {
    const invalid = validate({
      auditEnabled: true
    });
    expect(invalid).toBe(false);
  });

  it('should reject invalid mode value', () => {
    const invalid = validate({
      mode: 'standalone'
    });
    expect(invalid).toBe(false);
  });

  it('should reject invalid backend value', () => {
    const invalid = validate({
      backend: 'memory'
    });
    expect(invalid).toBe(false);
  });

  it('should have correct enum values for mode', () => {
    const modeSchema = manifest.configSchema.properties.mode;
    expect(modeSchema.enum).toEqual(['embedded', 'proxy']);
    expect(modeSchema.default).toBe('embedded');
  });

  it('should have correct enum values for backend', () => {
    const backendSchema = manifest.configSchema.properties.backend;
    expect(backendSchema.enum).toEqual(['keychain', '1password', 'vault', 'encrypted-file']);
    expect(backendSchema.default).toBe('keychain');
  });

  it('should have correct defaults for services', () => {
    const servicesSchema = manifest.configSchema.properties.services;
    expect(servicesSchema.default).toEqual(['anthropic', 'openai']);
  });

  it('should have correct default for proxyPort', () => {
    const portSchema = manifest.configSchema.properties.proxyPort;
    expect(portSchema.default).toBe(8081);
  });
});
