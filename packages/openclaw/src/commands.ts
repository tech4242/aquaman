/**
 * Slash commands for the OpenClaw plugin
 *
 * Provides /aquaman commands for users to interact with the plugin.
 */

import type { EmbeddedMode } from './embedded.js';
import type { ProxyManager } from './proxy-manager.js';
import type { PluginConfig } from './config-schema.js';

export interface CommandContext {
  config: PluginConfig;
  embeddedMode?: EmbeddedMode;
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
  lines.push(`Mode: ${ctx.config.mode || 'embedded'}`);
  lines.push(`Backend: ${ctx.config.backend || 'keychain'}`);
  lines.push(`Services: ${(ctx.config.services || []).join(', ')}`);

  if (ctx.config.mode === 'proxy') {
    if (ctx.proxyManager?.isRunning()) {
      const info = ctx.proxyManager.getConnectionInfo();
      lines.push('');
      lines.push('Proxy Status: Running');
      lines.push(`  URL: ${info?.baseUrl}`);
      lines.push(`  Port: ${info?.port}`);
      lines.push(`  Protocol: ${info?.protocol}`);
    } else {
      lines.push('');
      lines.push('Proxy Status: Not running');
    }
  } else if (ctx.embeddedMode) {
    const status = ctx.embeddedMode.getStatus();
    lines.push('');
    lines.push('Embedded Mode Status:');
    lines.push(`  Initialized: ${status.initialized}`);
    lines.push(`  Audit Enabled: ${status.auditEnabled}`);
  }

  // List credentials (without values)
  if (ctx.embeddedMode) {
    try {
      const creds = await ctx.embeddedMode.listCredentials();
      lines.push('');
      lines.push(`Stored Credentials: ${creds.length}`);
      for (const cred of creds) {
        lines.push(`  - ${cred.service}/${cred.key}`);
      }
    } catch (error) {
      lines.push('');
      lines.push('Credentials: (unavailable)');
    }
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
  ctx: CommandContext,
  service: string,
  key: string = 'api_key'
): Promise<CommandResult> {
  if (!ctx.embeddedMode) {
    return {
      success: false,
      message: 'Embedded mode not available. Use proxy mode for credential management.'
    };
  }

  // Note: In a real OpenClaw plugin, this would trigger a secure input prompt
  // For now, we return instructions
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
export async function listCommand(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.embeddedMode) {
    return {
      success: false,
      message: 'Embedded mode not available.'
    };
  }

  try {
    const creds = await ctx.embeddedMode.listCredentials();

    if (creds.length === 0) {
      return {
        success: true,
        message: 'No credentials stored.\n\nUse `aquaman credentials add <service> <key>` to add one.'
      };
    }

    const lines = ['Stored credentials:', ''];
    for (const cred of creds) {
      lines.push(`  ${cred.service}/${cred.key}`);
    }

    return {
      success: true,
      message: lines.join('\n'),
      data: creds
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to list credentials: ${error}`
    };
  }
}

/**
 * /aquaman logs - Show recent audit entries
 */
export async function logsCommand(ctx: CommandContext, count: number = 10): Promise<CommandResult> {
  if (!ctx.embeddedMode) {
    return {
      success: false,
      message: 'Embedded mode not available.'
    };
  }

  try {
    const entries = await ctx.embeddedMode.getRecentAuditEntries(count);

    if (entries.length === 0) {
      return {
        success: true,
        message: 'No audit entries found.'
      };
    }

    const lines = [`Last ${entries.length} audit entries:`, ''];
    for (const entry of entries) {
      const time = new Date(entry.timestamp).toISOString();
      const type = entry.type.toUpperCase().padEnd(16);
      let details = '';

      if (entry.type === 'credential_access') {
        details = `${entry.data.service} ${entry.data.operation} ${entry.data.success ? 'OK' : 'FAIL'}`;
      } else {
        details = JSON.stringify(entry.data).slice(0, 60);
      }

      lines.push(`${time} [${type}] ${details}`);
    }

    return {
      success: true,
      message: lines.join('\n'),
      data: entries
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get audit logs: ${error}`
    };
  }
}

/**
 * /aquaman verify - Verify audit log integrity
 */
export async function verifyCommand(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.embeddedMode) {
    return {
      success: false,
      message: 'Embedded mode not available.'
    };
  }

  try {
    const result = await ctx.embeddedMode.verifyAuditIntegrity();

    if (result.valid) {
      return {
        success: true,
        message: 'Audit log integrity verified. No tampering detected.'
      };
    } else {
      return {
        success: false,
        message: 'Audit log integrity FAILED!\n\n' +
          'Errors:\n' +
          result.errors.map(e => `  - ${e}`).join('\n')
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Failed to verify audit log: ${error}`
    };
  }
}

/**
 * /aquaman mode <embedded|proxy> - Switch mode
 */
export async function modeCommand(ctx: CommandContext, mode: 'embedded' | 'proxy'): Promise<CommandResult> {
  if (mode !== 'embedded' && mode !== 'proxy') {
    return {
      success: false,
      message: 'Invalid mode. Use "embedded" or "proxy".'
    };
  }

  // Mode switching requires configuration change
  return {
    success: true,
    message: `To switch to ${mode} mode, update your openclaw.json:\n\n` +
      `{\n  "plugins": {\n    "@aquaman/openclaw": {\n      "mode": "${mode}"\n    }\n  }\n}\n\n` +
      `Then restart OpenClaw.`
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

    case 'logs':
      const count = args[0] ? parseInt(args[0], 10) : 10;
      return logsCommand(ctx, count);

    case 'verify':
      return verifyCommand(ctx);

    case 'mode':
      if (args.length < 1) {
        return { success: false, message: 'Usage: /aquaman mode <embedded|proxy>' };
      }
      return modeCommand(ctx, args[0] as 'embedded' | 'proxy');

    case 'help':
    default:
      return {
        success: true,
        message: `aquaman plugin commands:

  /aquaman status    - Show plugin status and stored credentials
  /aquaman add       - Add a credential (shows instructions)
  /aquaman list      - List stored credentials
  /aquaman logs [n]  - Show recent audit entries (default: 10)
  /aquaman verify    - Verify audit log integrity
  /aquaman mode      - Switch between embedded and proxy mode
  /aquaman help      - Show this help message

Mode comparison:
  embedded: Simpler setup, credentials in Gateway memory
  proxy:    Stronger isolation, credentials in separate process`
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
      description: 'Show aquaman plugin status and stored credentials',
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
      name: 'mode',
      description: 'Switch between embedded and proxy mode',
      execute: async (args) => {
        const mode = args.mode || args._?.[0];
        if (!mode) {
          return 'Usage: /aquaman mode <embedded|proxy>';
        }
        const result = await modeCommand(ctx, mode as 'embedded' | 'proxy');
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
