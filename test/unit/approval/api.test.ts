/**
 * Tests for approval HTTP API
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ApprovalApi,
  createApprovalApi,
  apiApprove,
  apiDeny,
  apiGetPending
} from '../../../src/approval/api.js';
import { ApprovalManager, createApprovalManager } from '../../../src/approval/manager.js';

describe('ApprovalApi', () => {
  let api: ApprovalApi;
  let manager: ApprovalManager;
  const TEST_PORT = 18799;

  beforeEach(async () => {
    manager = createApprovalManager({
      channels: [],  // No notifications for tests
      timeout: 60,
      defaultOnTimeout: 'deny'
    });

    api = createApprovalApi({
      port: TEST_PORT,
      manager
    });

    await api.start();
  });

  afterEach(async () => {
    manager.cancelAll();
    await api.stop();
  });

  describe('lifecycle', () => {
    it('should start and report running', () => {
      expect(api.isRunning()).toBe(true);
    });

    it('should stop gracefully', async () => {
      await api.stop();
      expect(api.isRunning()).toBe(false);
    });
  });

  describe('GET /pending', () => {
    it('should return empty array when no pending', async () => {
      const pending = await apiGetPending(TEST_PORT);
      expect(pending).toEqual([]);
    });
  });

  describe('POST /approve/:id', () => {
    it('should return false for unknown id', async () => {
      const result = await apiApprove(TEST_PORT, 'unknown-id');
      expect(result).toBe(false);
    });
  });

  describe('POST /deny/:id', () => {
    it('should return false for unknown id', async () => {
      const result = await apiDeny(TEST_PORT, 'unknown-id');
      expect(result).toBe(false);
    });
  });

  describe('client functions with no server', () => {
    it('apiApprove should return false when server not running', async () => {
      await api.stop();
      const result = await apiApprove(TEST_PORT, 'any-id');
      expect(result).toBe(false);
    });

    it('apiDeny should return false when server not running', async () => {
      await api.stop();
      const result = await apiDeny(TEST_PORT, 'any-id');
      expect(result).toBe(false);
    });
  });
});
