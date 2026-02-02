/**
 * Mock OpenClaw gateway for testing
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { GatewayMessage } from '../../src/types.js';

export interface MockGatewayOptions {
  port: number;
  onMessage?: (message: GatewayMessage) => GatewayMessage | null;
}

export class MockOpenClawGateway {
  private server: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private options: MockGatewayOptions;

  constructor(options: MockGatewayOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = new WebSocketServer({
        port: this.options.port,
        host: '127.0.0.1'
      });

      this.server.on('connection', (ws) => {
        this.clients.add(ws);

        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString()) as GatewayMessage;

            let response: GatewayMessage | null = null;

            if (this.options.onMessage) {
              response = this.options.onMessage(message);
            } else {
              // Default echo response
              response = {
                jsonrpc: '2.0',
                id: message.id,
                result: { success: true, echo: message }
              };
            }

            if (response) {
              ws.send(JSON.stringify(response));
            }
          } catch {
            // Ignore parse errors
          }
        });

        ws.on('close', () => {
          this.clients.delete(ws);
        });
      });

      this.server.on('listening', resolve);
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  getClientCount(): number {
    return this.clients.size;
  }

  broadcast(message: GatewayMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
}

export function createMockGateway(options: MockGatewayOptions): MockOpenClawGateway {
  return new MockOpenClawGateway(options);
}

/**
 * Simple WebSocket client for testing
 */
export class TestClient {
  private ws: WebSocket | null = null;
  private messageQueue: GatewayMessage[] = [];
  private resolvers: Array<(msg: GatewayMessage) => void> = [];

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', resolve);
      this.ws.on('error', reject);

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as GatewayMessage;

          if (this.resolvers.length > 0) {
            const resolver = this.resolvers.shift()!;
            resolver(message);
          } else {
            this.messageQueue.push(message);
          }
        } catch {
          // Ignore parse errors
        }
      });
    });
  }

  send(message: GatewayMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  async receive(timeout = 5000): Promise<GatewayMessage> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Receive timeout'));
      }, timeout);

      this.resolvers.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export function createTestClient(): TestClient {
  return new TestClient();
}
