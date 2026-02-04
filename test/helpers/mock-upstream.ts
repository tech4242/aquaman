/**
 * Mock upstream server for E2E testing of credential injection
 *
 * This server:
 * - Records all incoming requests for assertions
 * - Validates expected auth headers
 * - Returns configurable mock responses
 */

import * as http from 'node:http';

export interface CapturedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timestamp: Date;
}

export interface MockResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string | object;
}

export interface StreamingResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks: string[];
  delayMs?: number; // Delay between chunks
}

export interface ExpectedAuth {
  header: string;
  value?: string;
  prefix?: string;
}

export class MockUpstream {
  private server: http.Server | null = null;
  private _requests: CapturedRequest[] = [];
  private _port: number = 0;
  private expectedAuth: ExpectedAuth | null = null;
  private mockResponse: MockResponse = {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: { success: true, mock: true }
  };
  private streamingResponse: StreamingResponse | null = null;
  private rejectUnauthorized = false;
  private responseDelay = 0; // Optional delay before any response

  /**
   * Get all captured requests
   */
  get requests(): CapturedRequest[] {
    return [...this._requests];
  }

  /**
   * Get the port the server is listening on
   */
  get port(): number {
    return this._port;
  }

  /**
   * Start the mock server
   * @param port Port to listen on. Use 0 for dynamic port allocation.
   */
  async start(port: number = 0): Promise<void> {
    if (this.server) {
      throw new Error('Mock upstream already running');
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', reject);

      this.server.listen(port, '127.0.0.1', () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this._port = address.port;
        } else {
          this._port = port;
        }
        resolve();
      });
    });
  }

  /**
   * Stop the mock server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.server = null;
          resolve();
        }
      });
    });
  }

  /**
   * Set expected auth header for validation
   * If set, requests without valid auth will receive 401
   */
  setExpectedAuth(auth: ExpectedAuth | null): void {
    this.expectedAuth = auth;
  }

  /**
   * Configure to reject unauthorized requests with 401
   */
  setRejectUnauthorized(reject: boolean): void {
    this.rejectUnauthorized = reject;
  }

  /**
   * Set the mock response to return
   */
  setMockResponse(response: MockResponse): void {
    this.mockResponse = response;
    this.streamingResponse = null;
  }

  /**
   * Set a streaming response (SSE) that sends chunks with delay
   */
  setStreamingResponse(response: StreamingResponse): void {
    this.streamingResponse = response;
  }

  /**
   * Set a delay before responding (useful for timeout tests)
   */
  setResponseDelay(delayMs: number): void {
    this.responseDelay = delayMs;
  }

  /**
   * Clear captured requests
   */
  clearRequests(): void {
    this._requests = [];
  }

  /**
   * Get the last captured request
   */
  getLastRequest(): CapturedRequest | undefined {
    return this._requests[this._requests.length - 1];
  }

  /**
   * Get request count
   */
  getRequestCount(): number {
    return this._requests.length;
  }

  /**
   * Assert that the last request had the expected auth header
   */
  assertAuthHeader(expected: { header: string; value: string }): void {
    const lastRequest = this.getLastRequest();
    if (!lastRequest) {
      throw new Error('No requests captured');
    }

    const headerKey = expected.header.toLowerCase();
    const actualValue = lastRequest.headers[headerKey];

    if (actualValue !== expected.value) {
      throw new Error(
        `Auth header mismatch.\n` +
        `Expected: ${expected.header}="${expected.value}"\n` +
        `Actual: ${expected.header}="${actualValue}"`
      );
    }
  }

  /**
   * Assert that a header was NOT present in the last request
   */
  assertNoHeader(header: string): void {
    const lastRequest = this.getLastRequest();
    if (!lastRequest) {
      throw new Error('No requests captured');
    }

    const headerKey = header.toLowerCase();
    if (headerKey in lastRequest.headers) {
      throw new Error(
        `Expected header "${header}" to be absent, but found: "${lastRequest.headers[headerKey]}"`
      );
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');

      // Capture request with normalized headers
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
        }
      }

      const captured: CapturedRequest = {
        path: req.url || '/',
        method: req.method || 'GET',
        headers,
        body,
        timestamp: new Date()
      };

      this._requests.push(captured);

      // Validate auth if expected
      if (this.expectedAuth && this.rejectUnauthorized) {
        const authValid = this.validateAuth(headers);
        if (!authValid) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing auth header' }));
          return;
        }
      }

      // Apply response delay if set
      const sendResponse = async () => {
        if (this.responseDelay > 0) {
          await new Promise(r => setTimeout(r, this.responseDelay));
        }

        // Check if streaming response is configured
        if (this.streamingResponse) {
          await this.sendStreamingResponse(res);
        } else {
          this.sendMockResponse(res);
        }
      };

      sendResponse();
    });
  }

  private sendMockResponse(res: http.ServerResponse): void {
    res.statusCode = this.mockResponse.statusCode || 200;

    if (this.mockResponse.headers) {
      for (const [key, value] of Object.entries(this.mockResponse.headers)) {
        res.setHeader(key, value);
      }
    }

    let responseBody: string;
    if (typeof this.mockResponse.body === 'object') {
      res.setHeader('Content-Type', 'application/json');
      responseBody = JSON.stringify(this.mockResponse.body);
    } else {
      responseBody = this.mockResponse.body || '';
    }

    res.end(responseBody);
  }

  private async sendStreamingResponse(res: http.ServerResponse): Promise<void> {
    const streaming = this.streamingResponse!;

    res.statusCode = streaming.statusCode || 200;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (streaming.headers) {
      for (const [key, value] of Object.entries(streaming.headers)) {
        res.setHeader(key, value);
      }
    }

    // Send chunks with optional delay
    for (const chunk of streaming.chunks) {
      res.write(chunk);
      if (streaming.delayMs && streaming.delayMs > 0) {
        await new Promise(r => setTimeout(r, streaming.delayMs));
      }
    }

    res.end();
  }

  private validateAuth(headers: Record<string, string>): boolean {
    if (!this.expectedAuth) {
      return true;
    }

    const headerKey = this.expectedAuth.header.toLowerCase();
    const actualValue = headers[headerKey];

    if (!actualValue) {
      return false;
    }

    if (this.expectedAuth.value) {
      return actualValue === this.expectedAuth.value;
    }

    if (this.expectedAuth.prefix) {
      return actualValue.startsWith(this.expectedAuth.prefix);
    }

    return true;
  }
}

/**
 * Factory function to create a mock upstream server
 */
export function createMockUpstream(): MockUpstream {
  return new MockUpstream();
}
