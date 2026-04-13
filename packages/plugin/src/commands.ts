/**
 * Slash commands for the OpenClaw plugin
 *
 * Provides /aquaman commands for users to interact with the plugin.
 * Non-interactive commands execute the aquaman proxy binary directly.
 * Interactive commands (add) show instructions since slash commands
 * run in the chat UI where TTY is not available.
 */

import type { ProxyManager } from './proxy-manager.js';
import { execAquamanProxyCli, findAquamanProxyBinary } from './proxy-manager.js';
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
  const cliInstalled = findAquamanProxyBinary() !== null;

  lines.push('aquaman plugin status');
  lines.push('');
  lines.push(`Backend: ${ctx.config.backend || 'keychain'}`);
  lines.push(`Services: ${(ctx.config.services || []).join(', ')}`);
  lines.push(`Proxy binary: ${cliInstalled ? 'found' : 'NOT FOUND'}`);

  if (ctx.proxyManager?.isRunning()) {
    const info = ctx.proxyManager.getConnectionInfo();
    lines.push('');
    lines.push('Proxy Status: Running');
    lines.push(`  Socket: ${info?.socketPath}`);
  } else {
    lines.push('');
    lines.push('Proxy Status: Not running');
    if (!cliInstalled) {
      lines.push('');
      lines.push('Setup: npm install -g aquaman-proxy && aquaman setup');
    }
  }

  return {
    success: true,
    message: lines.join('\n')
  };
}

/**
 * /aquaman add <service> - Add a credential (shows instructions — TTY not available in chat UI)
 */
export async function addCommand(
  _ctx: CommandContext,
  service: string,
  key: string = 'api_key'
): Promise<CommandResult> {
  return {
    success: true,
    message: `To add a credential for ${service}/${key}:\n\n` +
      `Run: openclaw aquaman credentials add ${service} ${key}\n` +
      `Or in terminal: aquaman credentials add ${service} ${key}\n\n` +
      `Or configure via environment variables:\n` +
      `  export AQUAMAN_${service.toUpperCase()}_${key.toUpperCase()}=<your-key>`
  };
}

/**
 * /aquaman list - List stored credentials
 */
export async function listCommand(_ctx: CommandContext): Promise<CommandResult> {
  try {
    const result = await execAquamanProxyCli(['credentials', 'list']);
    return { success: result.exitCode === 0, message: result.stdout || result.stderr };
  } catch (err: any) {
    return { success: false, message: `Failed: ${err.message}\n\nRun in terminal: aquaman credentials list` };
  }
}

/**
 * /aquaman doctor - Run diagnostic checks
 */
export async function doctorCommand(_ctx: CommandContext): Promise<CommandResult> {
  try {
    const result = await execAquamanProxyCli(['doctor']);
    return { success: result.exitCode === 0, message: result.stdout || result.stderr };
  } catch (err: any) {
    return { success: false, message: `Failed: ${err.message}\n\nRun in terminal: aquaman doctor` };
  }
}

/**
 * /aquaman logs - Show recent audit entries
 */
export async function logsCommand(_ctx: CommandContext, count: number = 10): Promise<CommandResult> {
  try {
    const result = await execAquamanProxyCli(['audit', 'tail', '-n', String(count)]);
    return { success: result.exitCode === 0, message: result.stdout || result.stderr };
  } catch (err: any) {
    return { success: false, message: `Failed: ${err.message}\n\nRun in terminal: aquaman audit tail` };
  }
}

/**
 * /aquaman verify - Verify audit log integrity
 */
export async function verifyCommand(_ctx: CommandContext): Promise<CommandResult> {
  try {
    const result = await execAquamanProxyCli(['audit', 'verify']);
    return { success: result.exitCode === 0, message: result.stdout || result.stderr };
  } catch (err: any) {
    return { success: false, message: `Failed: ${err.message}\n\nRun in terminal: aquaman audit verify` };
  }
}

/**
 * /aquaman policy - List policy rules
 */
export async function policyListCommand(_ctx: CommandContext): Promise<CommandResult> {
  try {
    const result = await execAquamanProxyCli(['policy', 'list']);
    return { success: result.exitCode === 0, message: result.stdout || result.stderr };
  } catch (err: any) {
    return { success: false, message: `Failed: ${err.message}\n\nRun in terminal: aquaman policy list` };
  }
}

/**
 * /aquaman services - List configured services
 */
export async function servicesListCommand(_ctx: CommandContext): Promise<CommandResult> {
  try {
    const result = await execAquamanProxyCli(['services', 'list']);
    return { success: result.exitCode === 0, message: result.stdout || result.stderr };
  } catch (err: any) {
    return { success: false, message: `Failed: ${err.message}\n\nRun in terminal: aquaman services list` };
  }
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

    case 'doctor':
      return doctorCommand(ctx);

    case 'logs': {
      const count = args[0] ? parseInt(args[0], 10) : 10;
      return logsCommand(ctx, count);
    }

    case 'verify':
      return verifyCommand(ctx);

    case 'policy':
      return policyListCommand(ctx);

    case 'services':
      return servicesListCommand(ctx);

    case 'help':
    default:
      return {
        success: true,
        message: `aquaman plugin commands:

  /aquaman status    - Show plugin and proxy status
  /aquaman doctor    - Run diagnostic checks
  /aquaman add       - Add a credential
  /aquaman list      - List stored credentials
  /aquaman policy    - List request policy rules
  /aquaman services  - List configured services
  /aquaman logs [n]  - Show recent audit entries
  /aquaman verify    - Verify audit log integrity
  /aquaman help      - Show this help message

CLI commands (via terminal or openclaw aquaman <cmd>):

  openclaw aquaman setup           - Run the setup wizard
  openclaw aquaman doctor          - Diagnose issues
  openclaw aquaman credentials list - List credentials
  openclaw aquaman credentials add  - Add a credential (interactive)
  openclaw aquaman policy-list     - Show policy rules
  openclaw aquaman audit-tail      - Recent audit entries
  openclaw aquaman services-list   - List services`
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
      name: 'doctor',
      description: 'Run diagnostic checks',
      execute: async () => {
        const result = await doctorCommand(ctx);
        return result.message;
      }
    },
    {
      name: 'policy',
      description: 'List request policy rules',
      execute: async () => {
        const result = await policyListCommand(ctx);
        return result.message;
      }
    },
    {
      name: 'services',
      description: 'List configured services',
      execute: async () => {
        const result = await servicesListCommand(ctx);
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
