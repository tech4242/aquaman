/**
 * Real-time alert evaluation and blocking
 */

import type {
  AlertRule,
  AlertAction,
  RiskLevel,
  ToolCall,
  PolicyViolation,
  TOOL_RISK_LEVELS
} from '../types.js';

export interface AlertResult {
  matched: boolean;
  rule?: AlertRule;
  action: AlertAction;
  severity: RiskLevel;
  message: string;
  shouldBlock: boolean;
  requiresApproval: boolean;
}

export interface AlertEngineOptions {
  rules: AlertRule[];
  onAlert?: (result: AlertResult, toolCall: ToolCall) => void;
}

export class AlertEngine {
  private rules: AlertRule[];
  private compiledPatterns: Map<string, RegExp>;
  private onAlert?: (result: AlertResult, toolCall: ToolCall) => void;

  constructor(options: AlertEngineOptions) {
    this.rules = options.rules;
    this.compiledPatterns = new Map();
    this.onAlert = options.onAlert;

    // Pre-compile string patterns to RegExp
    for (const rule of this.rules) {
      if (rule.pattern && typeof rule.pattern === 'string') {
        try {
          this.compiledPatterns.set(rule.id, new RegExp(rule.pattern, 'i'));
        } catch {
          console.error(`Invalid regex pattern in rule ${rule.id}: ${rule.pattern}`);
        }
      } else if (rule.pattern instanceof RegExp) {
        this.compiledPatterns.set(rule.id, rule.pattern);
      }
    }
  }

  evaluate(toolCall: ToolCall): AlertResult {
    for (const rule of this.rules) {
      const matched = this.matchRule(rule, toolCall);

      if (matched) {
        const result: AlertResult = {
          matched: true,
          rule,
          action: rule.action,
          severity: rule.severity,
          message: rule.message || `Alert triggered: ${rule.name}`,
          shouldBlock: rule.action === 'block',
          requiresApproval: rule.action === 'require_approval'
        };

        if (this.onAlert) {
          this.onAlert(result, toolCall);
        }

        return result;
      }
    }

    // No rule matched - allow by default
    return {
      matched: false,
      action: 'log',
      severity: 'low',
      message: 'No alert rules triggered',
      shouldBlock: false,
      requiresApproval: false
    };
  }

  private matchRule(rule: AlertRule, toolCall: ToolCall): boolean {
    // Match by tool name
    if (rule.tools && rule.tools.length > 0) {
      if (!rule.tools.includes(toolCall.tool)) {
        return false;
      }
    }

    // Match by pattern on command/params
    if (rule.pattern) {
      const pattern = this.compiledPatterns.get(rule.id);
      if (!pattern) return false;

      const stringToMatch = this.getMatchableString(toolCall);
      if (!pattern.test(stringToMatch)) {
        return false;
      }
    }

    // If we have tools specified without a pattern, we matched by tool
    if (rule.tools && rule.tools.length > 0 && !rule.pattern) {
      return true;
    }

    // If we have a pattern without tools, we matched by pattern
    if (rule.pattern && (!rule.tools || rule.tools.length === 0)) {
      return true;
    }

    // Both tools and pattern specified - we already checked both above
    if (rule.tools && rule.tools.length > 0 && rule.pattern) {
      return true;
    }

    return false;
  }

  private getMatchableString(toolCall: ToolCall): string {
    // For bash commands, extract the command string
    if (toolCall.tool === 'bash' && toolCall.params['command']) {
      return String(toolCall.params['command']);
    }

    // For file operations, include the path
    if (toolCall.tool === 'file_read' || toolCall.tool === 'file_write') {
      return String(toolCall.params['path'] || '');
    }

    // For browser/web operations, include the URL
    if (toolCall.tool === 'browser_navigate' || toolCall.tool === 'web_fetch') {
      return String(toolCall.params['url'] || '');
    }

    // For message sending, include recipient and content
    if (toolCall.tool === 'message_send') {
      const recipient = String(toolCall.params['recipient'] || '');
      const content = String(toolCall.params['content'] || '');
      return `${recipient} ${content}`;
    }

    // Fallback: stringify all params
    return JSON.stringify(toolCall.params);
  }

  addRule(rule: AlertRule): void {
    this.rules.push(rule);

    if (rule.pattern && typeof rule.pattern === 'string') {
      try {
        this.compiledPatterns.set(rule.id, new RegExp(rule.pattern, 'i'));
      } catch {
        console.error(`Invalid regex pattern in rule ${rule.id}: ${rule.pattern}`);
      }
    } else if (rule.pattern instanceof RegExp) {
      this.compiledPatterns.set(rule.id, rule.pattern);
    }
  }

  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex(r => r.id === ruleId);
    if (index >= 0) {
      this.rules.splice(index, 1);
      this.compiledPatterns.delete(ruleId);
      return true;
    }
    return false;
  }

  getRules(): AlertRule[] {
    return [...this.rules];
  }

  createPolicyViolation(
    rule: AlertRule,
    toolCall: ToolCall,
    reason: string
  ): PolicyViolation {
    return {
      rule: rule.id,
      action: rule.action,
      severity: rule.severity,
      toolCall,
      reason
    };
  }
}

export function createAlertEngine(options: AlertEngineOptions): AlertEngine {
  return new AlertEngine(options);
}

// Rate limiting tracker
export class RateLimiter {
  private windows: Map<string, number[]> = new Map();
  private windowSizeMs: number;
  private maxEvents: number;

  constructor(windowSizeMs: number = 60000, maxEvents: number = 60) {
    this.windowSizeMs = windowSizeMs;
    this.maxEvents = maxEvents;
  }

  checkLimit(key: string): { allowed: boolean; count: number } {
    const now = Date.now();
    const windowStart = now - this.windowSizeMs;

    let events = this.windows.get(key) || [];

    // Remove events outside the window
    events = events.filter(timestamp => timestamp > windowStart);

    const allowed = events.length < this.maxEvents;

    if (allowed) {
      events.push(now);
      this.windows.set(key, events);
    }

    return { allowed, count: events.length };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  resetAll(): void {
    this.windows.clear();
  }

  getCount(key: string): number {
    const now = Date.now();
    const windowStart = now - this.windowSizeMs;
    const events = this.windows.get(key) || [];
    return events.filter(timestamp => timestamp > windowStart).length;
  }
}

export function createRateLimiter(windowSizeMs?: number, maxEvents?: number): RateLimiter {
  return new RateLimiter(windowSizeMs, maxEvents);
}
