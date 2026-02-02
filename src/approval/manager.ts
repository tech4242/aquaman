/**
 * Approval workflow manager with notification channels
 */

import { generateId } from '../utils/hash.js';
import type { ApprovalRequest, ToolCall, ApprovalChannel } from '../types.js';

export interface ApprovalManagerOptions {
  channels: ApprovalChannel[];
  timeout: number;
  defaultOnTimeout: 'allow' | 'deny';
  onApprovalRequest?: (request: ApprovalRequest) => void;
  onApprovalResponse?: (request: ApprovalRequest) => void;
}

export interface PendingApproval {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class ApprovalManager {
  private options: ApprovalManagerOptions;
  private pendingApprovals = new Map<string, PendingApproval>();
  private notifiers: ApprovalNotifier[] = [];

  constructor(options: ApprovalManagerOptions) {
    this.options = options;
    this.initializeNotifiers();
  }

  private initializeNotifiers(): void {
    for (const channel of this.options.channels) {
      switch (channel.type) {
        case 'console':
          this.notifiers.push(new ConsoleNotifier());
          break;
        case 'slack':
          if (channel.webhook) {
            this.notifiers.push(new SlackNotifier(channel.webhook));
          }
          break;
        case 'discord':
          if (channel.webhook) {
            this.notifiers.push(new DiscordNotifier(channel.webhook));
          }
          break;
      }
    }
  }

  async requestApproval(toolCall: ToolCall, reason: string): Promise<boolean> {
    const request: ApprovalRequest = {
      id: generateId(),
      toolCall,
      reason,
      status: 'pending',
      requestedAt: new Date()
    };

    if (this.options.onApprovalRequest) {
      this.options.onApprovalRequest(request);
    }

    // Send notifications
    await this.notifyAll(request);

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.handleTimeout(request.id);
      }, this.options.timeout * 1000);

      this.pendingApprovals.set(request.id, {
        request,
        resolve,
        timeoutHandle
      });
    });
  }

  private async notifyAll(request: ApprovalRequest): Promise<void> {
    const notifications = this.notifiers.map(notifier =>
      notifier.notify(request).catch(error => {
        console.error(`Notification failed:`, error);
      })
    );
    await Promise.all(notifications);
  }

  approve(requestId: string, respondedBy?: string): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timeoutHandle);
    pending.request.status = 'approved';
    pending.request.respondedAt = new Date();
    pending.request.respondedBy = respondedBy;

    if (this.options.onApprovalResponse) {
      this.options.onApprovalResponse(pending.request);
    }

    this.pendingApprovals.delete(requestId);
    pending.resolve(true);
    return true;
  }

  deny(requestId: string, respondedBy?: string): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timeoutHandle);
    pending.request.status = 'denied';
    pending.request.respondedAt = new Date();
    pending.request.respondedBy = respondedBy;

    if (this.options.onApprovalResponse) {
      this.options.onApprovalResponse(pending.request);
    }

    this.pendingApprovals.delete(requestId);
    pending.resolve(false);
    return true;
  }

  private handleTimeout(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;

    pending.request.status = 'timeout';
    pending.request.respondedAt = new Date();

    if (this.options.onApprovalResponse) {
      this.options.onApprovalResponse(pending.request);
    }

    const approved = this.options.defaultOnTimeout === 'allow';
    this.pendingApprovals.delete(requestId);
    pending.resolve(approved);
  }

  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).map(p => p.request);
  }

  getPendingCount(): number {
    return this.pendingApprovals.size;
  }

  cancelAll(): void {
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.request.status = 'denied';
      pending.resolve(false);
    }
    this.pendingApprovals.clear();
  }
}

export interface ApprovalNotifier {
  notify(request: ApprovalRequest): Promise<void>;
}

export class ConsoleNotifier implements ApprovalNotifier {
  async notify(request: ApprovalRequest): Promise<void> {
    console.log('\n========================================');
    console.log('[APPROVAL REQUIRED]');
    console.log('----------------------------------------');
    console.log(`Request ID: ${request.id}`);
    console.log(`Tool: ${request.toolCall.tool}`);
    console.log(`Reason: ${request.reason}`);
    console.log(`Params: ${JSON.stringify(request.toolCall.params, null, 2)}`);
    console.log('----------------------------------------');
    console.log('Use: aquaman approve <request-id>');
    console.log('Or:  aquaman deny <request-id>');
    console.log('========================================\n');
  }
}

export class SlackNotifier implements ApprovalNotifier {
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async notify(request: ApprovalRequest): Promise<void> {
    const payload = {
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🔒 Approval Required - aquaman-clawed',
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Request ID:*\n\`${request.id}\``
            },
            {
              type: 'mrkdwn',
              text: `*Tool:*\n\`${request.toolCall.tool}\``
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Reason:*\n${request.reason}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Parameters:*\n\`\`\`${JSON.stringify(request.toolCall.params, null, 2)}\`\`\``
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Approve: \`aquaman approve ${request.id}\` | Deny: \`aquaman deny ${request.id}\``
            }
          ]
        }
      ]
    };

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }
}

export class DiscordNotifier implements ApprovalNotifier {
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async notify(request: ApprovalRequest): Promise<void> {
    const payload = {
      embeds: [
        {
          title: '🔒 Approval Required - aquaman-clawed',
          color: 0xff9900,
          fields: [
            {
              name: 'Request ID',
              value: `\`${request.id}\``,
              inline: true
            },
            {
              name: 'Tool',
              value: `\`${request.toolCall.tool}\``,
              inline: true
            },
            {
              name: 'Reason',
              value: request.reason
            },
            {
              name: 'Parameters',
              value: `\`\`\`json\n${JSON.stringify(request.toolCall.params, null, 2)}\`\`\``
            }
          ],
          footer: {
            text: `Approve: aquaman approve ${request.id} | Deny: aquaman deny ${request.id}`
          },
          timestamp: request.requestedAt.toISOString()
        }
      ]
    };

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }
}

export function createApprovalManager(options: ApprovalManagerOptions): ApprovalManager {
  return new ApprovalManager(options);
}
