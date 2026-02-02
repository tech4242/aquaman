/**
 * Command execution control - pattern filtering and blocking
 */

import type { CommandPermissions, CommandRule, RiskLevel } from '../types.js';

export interface CommandCheckResult {
  allowed: boolean;
  reason: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  matchedRule?: string;
}

export interface CommandControlOptions {
  permissions: CommandPermissions;
}

export class CommandControl {
  private allowedCommands: CommandRule[];
  private deniedCommands: string[];
  private dangerousPatterns: RegExp[];

  constructor(options: CommandControlOptions) {
    this.allowedCommands = options.permissions.allowedCommands;
    this.deniedCommands = options.permissions.deniedCommands;
    this.dangerousPatterns = options.permissions.dangerousPatterns.map(p =>
      typeof p === 'string' ? new RegExp(p, 'i') : p
    );
  }

  checkCommand(command: string): CommandCheckResult {
    const trimmedCommand = command.trim();

    // Check dangerous patterns first (highest priority - always block)
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(trimmedCommand)) {
        return {
          allowed: false,
          reason: `Command matches dangerous pattern: ${pattern.source}`,
          riskLevel: 'critical',
          requiresApproval: false,
          matchedRule: `dangerous:${pattern.source}`
        };
      }
    }

    // Check explicitly denied commands
    const baseCommand = this.extractBaseCommand(trimmedCommand);
    const fullDenied = this.deniedCommands.find(denied =>
      trimmedCommand.startsWith(denied)
    );

    if (fullDenied) {
      return {
        allowed: false,
        reason: `Command is explicitly denied: ${fullDenied}`,
        riskLevel: 'critical',
        requiresApproval: false,
        matchedRule: `denied:${fullDenied}`
      };
    }

    const baseDenied = this.deniedCommands.find(denied =>
      baseCommand === denied
    );

    if (baseDenied) {
      return {
        allowed: false,
        reason: `Base command is explicitly denied: ${baseDenied}`,
        riskLevel: 'critical',
        requiresApproval: false,
        matchedRule: `denied:${baseDenied}`
      };
    }

    // Check allowed commands with argument restrictions
    const rule = this.findMatchingRule(baseCommand);

    if (rule) {
      // Check denied arguments
      if (rule.deniedArgs) {
        for (const deniedArg of rule.deniedArgs) {
          if (trimmedCommand.includes(deniedArg)) {
            return {
              allowed: false,
              reason: `Command contains denied argument: ${deniedArg}`,
              riskLevel: 'high',
              requiresApproval: false,
              matchedRule: `${rule.command}:denied_arg:${deniedArg}`
            };
          }
        }
      }

      // Check if command uses only allowed arguments
      if (rule.allowedArgs && rule.allowedArgs.length > 0) {
        const args = this.extractArgs(trimmedCommand, baseCommand);
        const isAllowed = this.argsAllowed(args, rule.allowedArgs);

        if (!isAllowed) {
          return {
            allowed: false,
            reason: `Command arguments not in allowed list`,
            riskLevel: 'medium',
            requiresApproval: true,
            matchedRule: `${rule.command}:restricted_args`
          };
        }
      }

      return {
        allowed: true,
        reason: `Command matches allowed rule: ${rule.command}`,
        riskLevel: this.assessRisk(baseCommand),
        requiresApproval: false,
        matchedRule: `allowed:${rule.command}`
      };
    }

    // Command not in allowlist - assess risk and potentially require approval
    const riskLevel = this.assessRisk(baseCommand);

    if (riskLevel === 'critical') {
      return {
        allowed: false,
        reason: 'Unknown command with high-risk characteristics',
        riskLevel: 'critical',
        requiresApproval: false
      };
    }

    // Unknown commands require approval by default
    return {
      allowed: true,
      reason: 'Command not in allowlist - requires approval',
      riskLevel,
      requiresApproval: true
    };
  }

  private extractBaseCommand(command: string): string {
    // Handle pipes and redirects
    const firstPart = command.split(/[|><&;]/).map(p => p.trim())[0] || '';

    // Extract the actual command (first word)
    const parts = firstPart.split(/\s+/);
    const firstWord = parts[0] || '';

    // Handle env vars before command
    if (firstWord.includes('=') && parts.length > 1) {
      return parts[1] || '';
    }

    // Handle paths (e.g., /usr/bin/rm)
    const segments = firstWord.split('/');
    return segments[segments.length - 1];
  }

  private extractArgs(command: string, baseCommand: string): string[] {
    const firstPart = command.split(/[|><&;]/)[0] || '';
    const parts = firstPart.trim().split(/\s+/);

    // Find where the base command is and return everything after
    const cmdIndex = parts.findIndex(p => p.endsWith(baseCommand));
    if (cmdIndex >= 0) {
      return parts.slice(cmdIndex + 1);
    }

    return parts.slice(1);
  }

  private argsAllowed(args: string[], allowedArgs: string[]): boolean {
    // Extract subcommand (first non-flag arg)
    const subcommand = args.find(arg => !arg.startsWith('-'));

    if (!subcommand) {
      // No subcommand, just flags - generally allow
      return true;
    }

    return allowedArgs.some(allowed => subcommand.startsWith(allowed));
  }

  private findMatchingRule(baseCommand: string): CommandRule | undefined {
    return this.allowedCommands.find(rule => rule.command === baseCommand);
  }

  private assessRisk(baseCommand: string): RiskLevel {
    const highRiskCommands = ['rm', 'chmod', 'chown', 'kill', 'pkill', 'systemctl'];
    const mediumRiskCommands = ['mv', 'cp', 'curl', 'wget', 'npm', 'pip', 'apt'];

    if (highRiskCommands.includes(baseCommand)) {
      return 'high';
    }
    if (mediumRiskCommands.includes(baseCommand)) {
      return 'medium';
    }
    return 'low';
  }

  hasPipe(command: string): boolean {
    return command.includes('|');
  }

  hasRedirect(command: string): boolean {
    return /[><]/.test(command);
  }

  hasBackgroundExec(command: string): boolean {
    return command.trim().endsWith('&');
  }

  hasCommandChain(command: string): boolean {
    return /[;&]/.test(command) || command.includes('&&') || command.includes('||');
  }

  addAllowedCommand(rule: CommandRule): void {
    this.allowedCommands.push(rule);
  }

  addDeniedCommand(command: string): void {
    this.deniedCommands.push(command);
  }

  addDangerousPattern(pattern: string | RegExp): void {
    this.dangerousPatterns.push(
      typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern
    );
  }
}

export function createCommandControl(options: CommandControlOptions): CommandControl {
  return new CommandControl(options);
}
