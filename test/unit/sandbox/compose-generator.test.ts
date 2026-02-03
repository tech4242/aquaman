import { describe, it, expect, beforeEach } from 'vitest';
import { generateComposeConfig } from '../../../src/sandbox/compose-generator.js';
import { getDefaultConfig } from '../../../src/utils/config.js';
import type { WrapperConfig } from '../../../src/types.js';

describe('compose-generator', () => {
  let config: WrapperConfig;

  beforeEach(() => {
    config = getDefaultConfig();
  });

  describe('generateComposeConfig', () => {
    it('should generate valid compose config with version', () => {
      const compose = generateComposeConfig(config);
      expect(compose.version).toBe('3.8');
    });

    it('should include aquaman and openclaw services', () => {
      const compose = generateComposeConfig(config);
      expect(compose.services.aquaman).toBeDefined();
      expect(compose.services.openclaw).toBeDefined();
    });

    it('should configure internal network for isolation', () => {
      const compose = generateComposeConfig(config);

      expect(compose.networks.aquaman_net).toBeDefined();
      expect(compose.networks.aquaman_net.internal).toBe(true);
      expect(compose.networks.aquaman_net.driver).toBe('bridge');
    });

    it('should set openclaw to depend on aquaman health', () => {
      const compose = generateComposeConfig(config);

      expect(compose.services.openclaw.depends_on).toBeDefined();
      expect(compose.services.openclaw.depends_on?.aquaman).toEqual({
        condition: 'service_healthy'
      });
    });

    it('should configure aquaman healthcheck', () => {
      const compose = generateComposeConfig(config);

      expect(compose.services.aquaman.healthcheck).toBeDefined();
      expect(compose.services.aquaman.healthcheck?.test).toContain('wget');
    });

    it('should mount workspace in openclaw container', () => {
      config.sandbox.workspace = {
        hostPath: '/home/user/myworkspace',
        containerPath: '/workspace',
        readOnly: false
      };

      const compose = generateComposeConfig(config);
      const volumes = compose.services.openclaw.volumes;

      expect(volumes).toContain('/home/user/myworkspace:/workspace:rw');
    });

    it('should set read-only workspace when configured', () => {
      config.sandbox.workspace = {
        hostPath: '/home/user/myworkspace',
        containerPath: '/workspace',
        readOnly: true
      };

      const compose = generateComposeConfig(config);
      const volumes = compose.services.openclaw.volumes;

      expect(volumes).toContain('/home/user/myworkspace:/workspace:ro');
    });

    it('should NOT mount credential directories in openclaw', () => {
      const compose = generateComposeConfig(config);
      const volumes = compose.services.openclaw.volumes;

      // Verify no sensitive paths are mounted
      for (const vol of volumes) {
        expect(vol).not.toContain('.ssh');
        expect(vol).not.toContain('.aws');
        expect(vol).not.toContain('.gnupg');
        expect(vol).not.toContain('auth-profiles');
        expect(vol).not.toContain('.aquaman');
      }
    });

    it('should configure openclaw to use aquaman proxies', () => {
      // Disable TLS for this test to use HTTP
      config.credentials.tls = { enabled: false };

      const compose = generateComposeConfig(config);
      const env = compose.services.openclaw.environment;

      expect(env).toContain('ANTHROPIC_BASE_URL=http://aquaman:8081/anthropic');
      expect(env).toContain('OPENAI_BASE_URL=http://aquaman:8081/openai');
      expect(env).toContain('OPENCLAW_GATEWAY_HOST=aquaman');
      expect(env).toContain('OPENCLAW_NO_CREDENTIALS=true');
    });

    it('should use HTTPS when TLS is enabled', () => {
      config.credentials.tls = { enabled: true };

      const compose = generateComposeConfig(config);
      const env = compose.services.openclaw.environment;

      expect(env).toContain('ANTHROPIC_BASE_URL=https://aquaman:8081/anthropic');
      expect(env).toContain('OPENAI_BASE_URL=https://aquaman:8081/openai');
      expect(env).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0');
    });

    it('should enable OpenClaw internal sandbox when configured', () => {
      config.sandbox.enableOpenclawSandbox = true;

      const compose = generateComposeConfig(config);
      const env = compose.services.openclaw.environment;

      expect(env).toContain('OPENCLAW_SANDBOX_MODE=non-main');
    });

    it('should not enable OpenClaw internal sandbox when disabled', () => {
      config.sandbox.enableOpenclawSandbox = false;

      const compose = generateComposeConfig(config);
      const env = compose.services.openclaw.environment;

      expect(env).not.toContain('OPENCLAW_SANDBOX_MODE=non-main');
    });

    it('should use custom openclaw image when specified', () => {
      config.sandbox.openclawImage = 'myregistry/openclaw:custom';

      const compose = generateComposeConfig(config);

      expect(compose.services.openclaw.image).toBe('myregistry/openclaw:custom');
    });

    it('should configure resource limits when specified', () => {
      config.sandbox.resources = {
        cpus: '4',
        memory: '8g'
      };

      const compose = generateComposeConfig(config);

      expect(compose.services.openclaw.deploy?.resources.limits.cpus).toBe('4');
      expect(compose.services.openclaw.deploy?.resources.limits.memory).toBe('8g');
    });

    it('should add custom environment variables', () => {
      config.sandbox.environment = {
        MY_VAR: 'my_value',
        ANOTHER_VAR: 'another_value'
      };

      const compose = generateComposeConfig(config);
      const env = compose.services.openclaw.environment;

      expect(env).toContain('MY_VAR=my_value');
      expect(env).toContain('ANOTHER_VAR=another_value');
    });

    it('should only expose approval API port to host', () => {
      const compose = generateComposeConfig(config);
      const ports = compose.services.aquaman.ports;

      // Only approval API should be exposed
      expect(ports).toBeDefined();
      expect(ports?.length).toBe(1);
      expect(ports?.[0]).toContain('18791');
      expect(ports?.[0]).toContain('127.0.0.1');
    });

    it('should connect both services to aquaman_net', () => {
      const compose = generateComposeConfig(config);

      expect(compose.services.aquaman.networks).toContain('aquaman_net');
      expect(compose.services.openclaw.networks).toContain('aquaman_net');
    });
  });
});
