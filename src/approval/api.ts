/**
 * HTTP API for approval management
 * Allows CLI commands to communicate with running daemon
 */

import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApprovalManager } from './manager.js';

export interface ApprovalApiOptions {
  port: number;
  bindAddress?: string; // defaults to '0.0.0.0' for container access
  manager: ApprovalManager;
}

export class ApprovalApi {
  private server: http.Server | null = null;
  private options: ApprovalApiOptions;
  private running = false;

  constructor(options: ApprovalApiOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    const bindAddress = this.options.bindAddress || '0.0.0.0';
    return new Promise((resolve) => {
      this.server!.listen(this.options.port, bindAddress, () => {
        this.running = true;
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost`);
    const path = url.pathname;

    res.setHeader('Content-Type', 'application/json');

    // GET /pending - list pending approvals
    if (req.method === 'GET' && path === '/pending') {
      const pending = this.options.manager.getPendingApprovals();
      res.end(JSON.stringify({ pending }));
      return;
    }

    // POST /approve/:id
    if (req.method === 'POST' && path.startsWith('/approve/')) {
      const id = path.slice('/approve/'.length);
      const success = this.options.manager.approve(id, 'cli');
      res.statusCode = success ? 200 : 404;
      res.end(JSON.stringify({ success, id }));
      return;
    }

    // POST /deny/:id
    if (req.method === 'POST' && path.startsWith('/deny/')) {
      const id = path.slice('/deny/'.length);
      const success = this.options.manager.deny(id, 'cli');
      res.statusCode = success ? 200 : 404;
      res.end(JSON.stringify({ success, id }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.running = false;
        this.server = null;
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.running;
  }
}

export function createApprovalApi(options: ApprovalApiOptions): ApprovalApi {
  return new ApprovalApi(options);
}

// Client functions for CLI
export async function apiApprove(port: number, requestId: string): Promise<boolean> {
  return apiCall(port, 'POST', `/approve/${requestId}`);
}

export async function apiDeny(port: number, requestId: string): Promise<boolean> {
  return apiCall(port, 'POST', `/deny/${requestId}`);
}

export async function apiGetPending(port: number): Promise<unknown[]> {
  const res = await fetch(`http://127.0.0.1:${port}/pending`);
  const data = await res.json();
  return data.pending || [];
}

async function apiCall(port: number, method: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}
