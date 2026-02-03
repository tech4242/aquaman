/**
 * WebSocket proxy that intercepts OpenClaw gateway traffic
 * Sits between clients and the OpenClaw gateway to capture all tool calls
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { generateId } from '../utils/hash.js';
import type { GatewayMessage, ToolCall, WrapperConfig } from '../types.js';
import { AuditLogger } from '../audit/logger.js';
import { AlertEngine, AlertResult } from '../audit/alerting.js';

export interface GatewayProxyOptions {
  proxyPort: number;
  upstreamHost: string;
  upstreamPort: number;
  bindAddress?: string; // defaults to '0.0.0.0' for container access
  auditLogger: AuditLogger;
  alertEngine: AlertEngine;
  onToolCall?: (toolCall: ToolCall, alertResult: AlertResult) => Promise<boolean>;
  onToolResult?: (toolCallId: string, result: unknown) => void;
}

interface ClientConnection {
  id: string;
  clientWs: WebSocket;
  upstreamWs: WebSocket;
  sessionId: string;
  agentId: string;
  pendingCalls: Map<string | number, ToolCall>;
}

export class GatewayProxy {
  private server: WebSocketServer | null = null;
  private connections: Map<string, ClientConnection> = new Map();
  private options: GatewayProxyOptions;
  private running: boolean = false;

  constructor(options: GatewayProxyOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Gateway proxy already running');
    }

    await this.options.auditLogger.initialize();

    const bindAddress = this.options.bindAddress || '0.0.0.0';
    this.server = new WebSocketServer({
      port: this.options.proxyPort,
      host: bindAddress
    });

    this.server.on('connection', (clientWs, request) => {
      this.handleConnection(clientWs, request);
    });

    this.server.on('error', (error) => {
      console.error('Gateway proxy server error:', error);
    });

    this.running = true;
    console.log(`Gateway proxy listening on ${bindAddress}:${this.options.proxyPort}`);
    console.log(`Forwarding to ${this.options.upstreamHost}:${this.options.upstreamPort}`);
  }

  private handleConnection(clientWs: WebSocket, request: IncomingMessage): void {
    const connectionId = generateId();
    const sessionId = this.extractSessionId(request);
    const agentId = this.extractAgentId(request);

    // Connect to upstream OpenClaw gateway
    const upstreamUrl = `ws://${this.options.upstreamHost}:${this.options.upstreamPort}${request.url || ''}`;
    const upstreamWs = new WebSocket(upstreamUrl);

    const connection: ClientConnection = {
      id: connectionId,
      clientWs,
      upstreamWs,
      sessionId,
      agentId,
      pendingCalls: new Map()
    };

    this.connections.set(connectionId, connection);

    upstreamWs.on('open', () => {
      console.log(`Connection ${connectionId}: Upstream connected`);
    });

    upstreamWs.on('message', async (data) => {
      await this.handleUpstreamMessage(connection, data);
    });

    upstreamWs.on('close', () => {
      clientWs.close();
      this.connections.delete(connectionId);
    });

    upstreamWs.on('error', (error) => {
      console.error(`Connection ${connectionId}: Upstream error:`, error);
      clientWs.close();
      this.connections.delete(connectionId);
    });

    clientWs.on('message', async (data) => {
      await this.handleClientMessage(connection, data);
    });

    clientWs.on('close', () => {
      upstreamWs.close();
      this.connections.delete(connectionId);
    });

    clientWs.on('error', (error) => {
      console.error(`Connection ${connectionId}: Client error:`, error);
      upstreamWs.close();
      this.connections.delete(connectionId);
    });
  }

  private extractSessionId(request: IncomingMessage): string {
    // Try to extract session ID from URL or headers
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    return url.searchParams.get('sessionId') || 'unknown';
  }

  private extractAgentId(request: IncomingMessage): string {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    return url.searchParams.get('agentId') || 'unknown';
  }

  private async handleClientMessage(
    connection: ClientConnection,
    data: WebSocket.RawData
  ): Promise<void> {
    const message = this.parseMessage(data);

    if (!message) {
      // Pass through unparseable messages
      if (connection.upstreamWs.readyState === WebSocket.OPEN) {
        connection.upstreamWs.send(data);
      }
      return;
    }

    // Check if this is a tool call (JSON-RPC style)
    if (message.method && this.isToolCall(message.method)) {
      const toolCall = await this.processToolCall(connection, message);

      if (!toolCall) {
        // Tool call was blocked
        this.sendBlockedResponse(connection, message);
        return;
      }
    }

    // Forward to upstream
    if (connection.upstreamWs.readyState === WebSocket.OPEN) {
      connection.upstreamWs.send(data);
    }
  }

  private async handleUpstreamMessage(
    connection: ClientConnection,
    data: WebSocket.RawData
  ): Promise<void> {
    const message = this.parseMessage(data);

    if (message && message.id !== undefined) {
      // This might be a response to a tool call
      const pendingCall = connection.pendingCalls.get(message.id);

      if (pendingCall) {
        // Log the result
        await this.options.auditLogger.logToolResult(
          connection.sessionId,
          connection.agentId,
          pendingCall.id,
          message.result,
          message.error?.message
        );

        if (this.options.onToolResult) {
          this.options.onToolResult(pendingCall.id, message.result);
        }

        connection.pendingCalls.delete(message.id);
      }
    }

    // Forward to client
    if (connection.clientWs.readyState === WebSocket.OPEN) {
      connection.clientWs.send(data);
    }
  }

  private parseMessage(data: WebSocket.RawData): GatewayMessage | null {
    try {
      const str = data.toString();
      return JSON.parse(str) as GatewayMessage;
    } catch {
      return null;
    }
  }

  private isToolCall(method: string): boolean {
    // Common OpenClaw tool method patterns
    const toolPatterns = [
      'tool/',
      'tools/',
      'bash',
      'file_',
      'browser_',
      'message_',
      'sessions_',
      'cron_',
      'camera_',
      'screen_',
      'location_',
      'web_'
    ];

    return toolPatterns.some(pattern => method.includes(pattern));
  }

  private async processToolCall(
    connection: ClientConnection,
    message: GatewayMessage
  ): Promise<ToolCall | null> {
    const toolName = this.extractToolName(message.method || '');
    const params = message.params || {};

    const toolCall: ToolCall = {
      id: generateId(),
      sessionId: connection.sessionId,
      agentId: connection.agentId,
      tool: toolName,
      params,
      timestamp: new Date()
    };

    // Evaluate against alert rules
    const alertResult = this.options.alertEngine.evaluate(toolCall);

    // Log the tool call
    await this.options.auditLogger.logToolCall(
      connection.sessionId,
      connection.agentId,
      toolName,
      params
    );

    // Check if blocked
    if (alertResult.shouldBlock) {
      await this.options.auditLogger.logPolicyViolation(
        connection.sessionId,
        connection.agentId,
        {
          rule: alertResult.rule?.id || 'unknown',
          action: 'block',
          severity: alertResult.severity,
          toolCall,
          reason: alertResult.message
        }
      );

      console.log(`[BLOCKED] ${toolName}: ${alertResult.message}`);
      return null;
    }

    // Check if requires approval
    if (alertResult.requiresApproval) {
      if (this.options.onToolCall) {
        const approved = await this.options.onToolCall(toolCall, alertResult);
        if (!approved) {
          console.log(`[DENIED] ${toolName}: Approval denied`);
          return null;
        }
      }
    }

    // Track pending call for result matching
    if (message.id !== undefined) {
      connection.pendingCalls.set(message.id, toolCall);
    }

    return toolCall;
  }

  private extractToolName(method: string): string {
    // Extract tool name from method string
    // e.g., "tool/bash" -> "bash", "tools/file_read" -> "file_read"
    const parts = method.split('/');
    return parts[parts.length - 1];
  }

  private sendBlockedResponse(
    connection: ClientConnection,
    originalMessage: GatewayMessage
  ): void {
    const response: GatewayMessage = {
      jsonrpc: '2.0',
      id: originalMessage.id,
      error: {
        code: -32000,
        message: '[BLOCKED] Operation denied by security policy'
      }
    };

    if (connection.clientWs.readyState === WebSocket.OPEN) {
      connection.clientWs.send(JSON.stringify(response));
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) {
      return;
    }

    // Close all connections
    for (const connection of this.connections.values()) {
      connection.clientWs.close();
      connection.upstreamWs.close();
    }
    this.connections.clear();

    // Close server
    return new Promise((resolve, reject) => {
      this.server!.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.running = false;
          this.server = null;
          resolve();
        }
      });
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}

export function createGatewayProxy(options: GatewayProxyOptions): GatewayProxy {
  return new GatewayProxy(options);
}
