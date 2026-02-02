/**
 * Tests for network control
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NetworkControl, createNetworkControl } from '../../../src/permissions/network-control.js';
import type { NetworkPermissions } from '../../../src/types.js';

describe('NetworkControl', () => {
  let networkControl: NetworkControl;

  const defaultPermissions: NetworkPermissions = {
    defaultAction: 'deny',
    allowedDomains: [
      'api.anthropic.com',
      'api.openai.com',
      '*.slack.com',
      '*.discord.com',
      'api.github.com'
    ],
    deniedDomains: [
      '*.onion',
      'localhost',
      '127.0.0.1'
    ],
    deniedPorts: [22, 23, 25, 3389]
  };

  beforeEach(() => {
    networkControl = createNetworkControl({ permissions: defaultPermissions });
  });

  describe('checkUrl', () => {
    describe('allowed domains', () => {
      it('should allow Anthropic API', () => {
        const result = networkControl.checkUrl('https://api.anthropic.com/v1/messages');

        expect(result.allowed).toBe(true);
        expect(result.riskLevel).toBe('low');
      });

      it('should allow OpenAI API', () => {
        const result = networkControl.checkUrl('https://api.openai.com/v1/chat/completions');

        expect(result.allowed).toBe(true);
      });

      it('should allow Slack subdomains', () => {
        expect(networkControl.checkUrl('https://hooks.slack.com/services/abc').allowed).toBe(true);
        expect(networkControl.checkUrl('https://api.slack.com/methods').allowed).toBe(true);
        expect(networkControl.checkUrl('https://slack.com/api/chat.postMessage').allowed).toBe(true);
      });

      it('should allow Discord subdomains', () => {
        expect(networkControl.checkUrl('https://discord.com/api/webhooks/123').allowed).toBe(true);
        expect(networkControl.checkUrl('https://cdn.discord.com/attachments/123').allowed).toBe(true);
      });

      it('should allow GitHub API', () => {
        const result = networkControl.checkUrl('https://api.github.com/repos/owner/repo');

        expect(result.allowed).toBe(true);
      });
    });

    describe('denied domains', () => {
      it('should deny .onion domains', () => {
        const result = networkControl.checkUrl('http://example.onion/api');

        expect(result.allowed).toBe(false);
        expect(result.riskLevel).toBe('critical');
      });

      it('should deny localhost', () => {
        const result = networkControl.checkUrl('http://localhost:8080/admin');

        expect(result.allowed).toBe(false);
      });

      it('should deny 127.0.0.1', () => {
        const result = networkControl.checkUrl('http://127.0.0.1:3000/api');

        expect(result.allowed).toBe(false);
      });
    });

    describe('denied ports', () => {
      it('should deny SSH port', () => {
        const result = networkControl.checkUrl('http://example.com:22/');

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Port 22');
      });

      it('should deny telnet port', () => {
        const result = networkControl.checkUrl('http://example.com:23/');

        expect(result.allowed).toBe(false);
      });

      it('should deny SMTP port', () => {
        const result = networkControl.checkUrl('http://example.com:25/');

        expect(result.allowed).toBe(false);
      });

      it('should deny RDP port', () => {
        const result = networkControl.checkUrl('http://example.com:3389/');

        expect(result.allowed).toBe(false);
      });
    });

    describe('unknown domains with default deny', () => {
      it('should deny unknown domains', () => {
        const result = networkControl.checkUrl('https://unknown-api.com/endpoint');

        expect(result.allowed).toBe(false);
        expect(result.requiresApproval).toBe(true);
        expect(result.riskLevel).toBe('medium');
      });
    });

    describe('default allow mode', () => {
      it('should allow unknown domains when defaultAction is allow', () => {
        const allowControl = createNetworkControl({
          permissions: {
            ...defaultPermissions,
            defaultAction: 'allow'
          }
        });

        const result = allowControl.checkUrl('https://random-api.com/endpoint');

        expect(result.allowed).toBe(true);
        expect(result.riskLevel).toBe('medium');
      });
    });

    describe('invalid URLs', () => {
      it('should deny invalid URLs', () => {
        const result = networkControl.checkUrl('not-a-valid-url');

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Invalid URL');
      });
    });
  });

  describe('checkHostPort', () => {
    it('should check host and port separately', () => {
      const result = networkControl.checkHostPort('api.anthropic.com', 443);

      expect(result.allowed).toBe(true);
    });

    it('should deny blocked ports even for allowed hosts', () => {
      const result = networkControl.checkHostPort('api.anthropic.com', 22);

      expect(result.allowed).toBe(false);
    });
  });

  describe('isInternalAddress', () => {
    it('should identify localhost', () => {
      expect(networkControl.isInternalAddress('localhost')).toBe(true);
    });

    it('should identify 127.0.0.1', () => {
      expect(networkControl.isInternalAddress('127.0.0.1')).toBe(true);
    });

    it('should identify IPv6 loopback', () => {
      expect(networkControl.isInternalAddress('::1')).toBe(true);
    });

    it('should identify 10.x.x.x', () => {
      expect(networkControl.isInternalAddress('10.0.0.1')).toBe(true);
      expect(networkControl.isInternalAddress('10.255.255.255')).toBe(true);
    });

    it('should identify 172.16-31.x.x', () => {
      expect(networkControl.isInternalAddress('172.16.0.1')).toBe(true);
      expect(networkControl.isInternalAddress('172.31.255.255')).toBe(true);
    });

    it('should identify 192.168.x.x', () => {
      expect(networkControl.isInternalAddress('192.168.1.1')).toBe(true);
      expect(networkControl.isInternalAddress('192.168.0.1')).toBe(true);
    });

    it('should identify .local domains', () => {
      expect(networkControl.isInternalAddress('myhost.local')).toBe(true);
    });

    it('should not flag external addresses', () => {
      expect(networkControl.isInternalAddress('api.anthropic.com')).toBe(false);
      expect(networkControl.isInternalAddress('8.8.8.8')).toBe(false);
    });
  });

  describe('isSuspiciousDomain', () => {
    it('should flag IP address URLs', () => {
      const result = networkControl.isSuspiciousDomain('192.168.1.1');

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('IP address');
    });

    it('should flag .onion TLD', () => {
      const result = networkControl.isSuspiciousDomain('example.onion');

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('TLD');
    });

    it('should flag .bit TLD', () => {
      const result = networkControl.isSuspiciousDomain('example.bit');

      expect(result.suspicious).toBe(true);
    });

    it('should flag .i2p TLD', () => {
      const result = networkControl.isSuspiciousDomain('example.i2p');

      expect(result.suspicious).toBe(true);
    });

    it('should flag non-ASCII characters', () => {
      const result = networkControl.isSuspiciousDomain('exаmple.com'); // 'а' is Cyrillic

      expect(result.suspicious).toBe(true);
      expect(result.reason).toContain('Non-ASCII');
    });

    it('should not flag normal domains', () => {
      const result = networkControl.isSuspiciousDomain('api.example.com');

      expect(result.suspicious).toBe(false);
    });
  });

  describe('addAllowedDomain', () => {
    it('should add new allowed domain', () => {
      networkControl.addAllowedDomain('api.newservice.com');

      const result = networkControl.checkUrl('https://api.newservice.com/endpoint');
      expect(result.allowed).toBe(true);
    });
  });

  describe('addDeniedDomain', () => {
    it('should add new denied domain', () => {
      networkControl.addDeniedDomain('evil.com');

      const result = networkControl.checkUrl('https://evil.com/api');
      expect(result.allowed).toBe(false);
    });
  });

  describe('addDeniedPort', () => {
    it('should add new denied port', () => {
      networkControl.addDeniedPort(8080);

      const result = networkControl.checkUrl('https://api.anthropic.com:8080/');
      expect(result.allowed).toBe(false);
    });
  });

  describe('getPermissions', () => {
    it('should return current permissions', () => {
      const permissions = networkControl.getPermissions();

      expect(permissions.defaultAction).toBe('deny');
      expect(permissions.allowedDomains).toContain('api.anthropic.com');
      expect(permissions.deniedDomains).toContain('localhost');
      expect(permissions.deniedPorts).toContain(22);
    });
  });
});
