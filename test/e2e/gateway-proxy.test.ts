/**
 * End-to-end tests for gateway proxy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GatewayProxy, createGatewayProxy } from '../../src/proxy/gateway-proxy.js';
import { AuditLogger, createAuditLogger } from '../../src/audit/logger.js';
import { AlertEngine, createAlertEngine } from '../../src/audit/alerting.js';
import type { AlertRule } from '../../src/types.js';

describe('GatewayProxy E2E', () => {
  let proxy: GatewayProxy;
  let auditLogger: AuditLogger;
  let alertEngine: AlertEngine;
  let testDir: string;

  const MOCK_PORT = 19789;
  const PROXY_PORT = 19790;

  const defaultRules: AlertRule[] = [
    {
      id: 'block-dangerous',
      name: 'Block dangerous commands',
      pattern: 'rm\\s+-rf\\s+/',
      action: 'block',
      severity: 'critical',
      message: 'Dangerous command blocked'
    }
  ];

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `aquaman-e2e-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    auditLogger = createAuditLogger({
      logDir: testDir,
      enabled: true
    });

    alertEngine = createAlertEngine({
      rules: defaultRules
    });

    // Start proxy (without mock gateway - we test proxy startup/lifecycle)
    proxy = createGatewayProxy({
      proxyPort: PROXY_PORT,
      upstreamHost: '127.0.0.1',
      upstreamPort: MOCK_PORT,
      auditLogger,
      alertEngine
    });
  });

  afterEach(async () => {
    if (proxy.isRunning()) {
      await proxy.stop();
    }

    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('proxy lifecycle', () => {
    it('should start successfully', async () => {
      await proxy.start();

      expect(proxy.isRunning()).toBe(true);
    });

    it('should report not running before start', () => {
      expect(proxy.isRunning()).toBe(false);
    });

    it('should report zero connections initially', async () => {
      await proxy.start();

      expect(proxy.getConnectionCount()).toBe(0);
    });

    it('should stop gracefully', async () => {
      await proxy.start();
      await proxy.stop();

      expect(proxy.isRunning()).toBe(false);
    });

    it('should throw when started twice', async () => {
      await proxy.start();

      await expect(proxy.start()).rejects.toThrow('already running');
    });

    it('should handle stop when not running', async () => {
      // Should not throw
      await proxy.stop();
      expect(proxy.isRunning()).toBe(false);
    });
  });

  describe('audit integration', () => {
    it('should initialize audit logger on start', async () => {
      await proxy.start();

      // Verify audit directory was created
      expect(fs.existsSync(testDir)).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'archive'))).toBe(true);
    });
  });

  describe('alert engine integration', () => {
    it('should use provided alert rules', async () => {
      await proxy.start();

      // The alert engine should have our rules
      expect(alertEngine.getRules()).toHaveLength(1);
      expect(alertEngine.getRules()[0].id).toBe('block-dangerous');
    });
  });
});
