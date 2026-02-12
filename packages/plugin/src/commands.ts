/**
 * Slash commands for the OpenClaw plugin
 *
 * Provides /aquaman commands for users to interact with the plugin.
 */

import type { ProxyManager } from './proxy-manager.js';
import type { PluginConfig } from './config-schema.js';

export interface CommandContext {
  config: PluginConfig;
  proxyManager?: ProxyManager;
}

export interface CommandResult {
  success: boolean;
  message: string;
  data?: any;
}

/**
 * Plugin command definition for OpenClaw
 */
export interface PluginCommand {
  name: string;
  description: string;
  execute: (args: Record<string, string>) => Promise<string | object>;
}

/**
 * /aquaman status - Show plugin status
 */
export async function statusCommand(ctx: CommandContext): Promise<CommandResult> {
  const lines: string[] = [];

  lines.push('aquaman plugin status');
  lines.push('');
  lines.push(`Backend: ${ctx.config.backend || 'keychain'}`);
  lines.push(`Services: ${(ctx.config.services || []).join(', ')}`);

  if (ctx.proxyManager?.isRunning()) {
    const info = ctx.proxyManager.getConnectionInfo();
    lines.push('');
    lines.push('Proxy Status: Running');
    lines.push(`  Socket: ${info?.socketPath}`);
  } else {
    lines.push('');
    lines.push('Proxy Status: Not running');
  }

  return {
    success: true,
    message: lines.join('\n')
  };
}

/**
 * /aquaman add <service> - Add a credential (prompts for value)
 */
export async function addCommand(
  _ctx: CommandContext,
  service: string,
  key: string = 'api_key'
): Promise<CommandResult> {
  return {
    success: true,
    message: `To add a credential for ${service}/${key}:\n\n` +
      `Run: aquaman credentials add ${service} ${key}\n\n` +
      `Or configure via environment variables:\n` +
      `  export AQUAMAN_${service.toUpperCase()}_${key.toUpperCase()}=<your-key>`
  };
}

/**
 * /aquaman list - List stored credentials
 */
export async function listCommand(_ctx: CommandContext): Promise<CommandResult> {
  return {
    success: true,
    message: 'Run in your terminal:\n  aquaman credentials list'
  };
}

/**
 * /aquaman logs - Show recent audit entries
 */
export async function logsCommand(_ctx: CommandContext, _count: number = 10): Promise<CommandResult> {
  return {
    success: true,
    message: 'Run in your terminal:\n  aquaman audit tail'
  };
}

/**
 * /aquaman verify - Verify audit log integrity
 */
export async function verifyCommand(_ctx: CommandContext): Promise<CommandResult> {
  return {
    success: true,
    message: 'Run in your terminal:\n  aquaman audit verify'
  };
}

/**
 * Parse and execute a command
 */
export async function executeCommand(
  ctx: CommandContext,
  command: string,
  args: string[]
): Promise<CommandResult> {
  switch (command.toLowerCase()) {
    case 'status':
      return statusCommand(ctx);

    case 'add':
      if (args.length < 1) {
        return { success: false, message: 'Usage: /aquaman add <service> [key]' };
      }
      return addCommand(ctx, args[0], args[1]);

    case 'list':
      return listCommand(ctx);

    case 'logs': {
      const count = args[0] ? parseInt(args[0], 10) : 10;
      return logsCommand(ctx, count);
    }

    case 'verify':
      return verifyCommand(ctx);

    case 'help':
    default:
      return {
        success: true,
        message: `aquaman plugin commands:

  /aquaman status    - Show plugin status
  /aquaman add       - Add a credential (shows instructions)
  /aquaman list      - List stored credentials
  /aquaman logs [n]  - Show recent audit entries
  /aquaman verify    - Verify audit log integrity
  /aquaman help      - Show this help message`
      };
  }
}

/**
 * Get available commands for OpenClaw to register
 */
export function getAvailableCommands(ctx: CommandContext): PluginCommand[] {
  return [
    {
      name: 'status',
      description: 'Show aquaman plugin status',
      execute: async () => {
        const result = await statusCommand(ctx);
        return result.message;
      }
    },
    {
      name: 'add',
      description: 'Add a credential for a service',
      execute: async (args) => {
        const service = args.service || args._?.[0];
        const key = args.key || args._?.[1] || 'api_key';
        if (!service) {
          return 'Usage: /aquaman add <service> [key]';
        }
        const result = await addCommand(ctx, service, key);
        return result.message;
      }
    },
    {
      name: 'list',
      description: 'List stored credentials',
      execute: async () => {
        const result = await listCommand(ctx);
        return result.message;
      }
    },
    {
      name: 'logs',
      description: 'Show recent audit log entries',
      execute: async (args) => {
        const count = args.count ? parseInt(args.count, 10) : 10;
        const result = await logsCommand(ctx, count);
        return result.message;
      }
    },
    {
      name: 'verify',
      description: 'Verify audit log integrity',
      execute: async () => {
        const result = await verifyCommand(ctx);
        return result.message;
      }
    },
    {
      name: 'help',
      description: 'Show help for aquaman commands',
      execute: async () => {
        const result = await executeCommand(ctx, 'help', []);
        return result.message;
      }
    }
  ];
}
