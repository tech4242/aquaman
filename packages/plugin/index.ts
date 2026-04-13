/**
 * Aquaman OpenClaw Plugin
 *
 * Credential isolation for OpenClaw.
 * Credentials never enter the agent process - they're managed by a separate proxy.
 *
 * Usage:
 *   1. Install aquaman: npm install -g aquaman-proxy
 *   2. Store credentials: aquaman credentials add anthropic api_key
 *   3. Enable this plugin in openclaw.json
 *
 * The plugin will:
 *   - Start the aquaman proxy on plugin load
 *   - Set ANTHROPIC_BASE_URL, OPENAI_BASE_URL etc. to route through proxy via UDS
 *   - The proxy injects credentials into requests
 *   - Agent never sees the actual API keys
 */

// OpenClaw plugin SDK types — defined locally to avoid import resolution failures.
// The root import "openclaw/plugin-sdk" broke for user-installed plugins in OpenClaw 2026.3.23
// (GitHub issue #53403: jiti resolver can't walk from ~/.openclaw/extensions/ to OpenClaw's
// package tree). Since we only use these as compile-time types, local definitions are zero-risk
// and make the plugin resilient to SDK path changes. Revert to SDK import if OpenClaw stabilizes
// module resolution for user-installed plugins.

interface OpenClawPluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface OpenClawPluginApi {
  logger: OpenClawPluginLogger;
  pluginConfig: unknown;
  registerService(def: {
    id: string;
    start(ctx: { logger: OpenClawPluginLogger }): void | Promise<void>;
    stop(ctx: { logger: OpenClawPluginLogger }): void | Promise<void>;
  }): void;
  registerCommand(def: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler(): Promise<{ text: string }>;
  }): void;
  registerCli?(
    fn: (opts: { program: any }) => void,
    opts: { commands: string[] },
  ): void;
  registerTool(
    factory: () => {
      name: string;
      label: string;
      description: string;
      parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
      execute(toolCallId: string, params: unknown): Promise<{
        content: { type: "text"; text: string }[];
        details: unknown;
      }>;
    },
    opts: { names: string[] },
  ): void;
}

type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
};
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HttpInterceptor, createHttpInterceptor } from "./src/http-interceptor.js";
import { createProxyManager, findAquamanProxyBinary, execAquamanProxyCli, execAquamanProxyInteractive, type ProxyManager } from "./src/proxy-manager.js";
import { loadHostMap, isProxyRunning, getProxyVersion } from "./src/proxy-health.js";

/**
 * Find an executable in PATH using filesystem checks (no shell execution).
 * Avoids execSync("which ...") which triggers dangerous-exec security audit flags.
 */
function findInPath(name: string): string | null {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable in this dir
    }
  }
  return null;
}

// Read plugin version from package.json
const pluginPkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'package.json');
let PLUGIN_VERSION = 'unknown';
try { PLUGIN_VERSION = JSON.parse(fs.readFileSync(pluginPkgPath, 'utf-8')).version; } catch { /* ok */ }

let proxyManager: ProxyManager | null = null;
let httpInterceptor: HttpInterceptor | null = null;
let socketPath: string | null = null;
let dynamicHostMap: Map<string, string> | null = null;
let configuredServices: string[] = ["anthropic", "openai"];

/** Default socket path */
function getDefaultSocketPath(): string {
  const configDir = path.join(os.homedir(), '.aquaman');
  return path.join(configDir, 'proxy.sock');
}

/** Fallback host map used when proxy doesn't provide one */
const FALLBACK_HOST_MAP = new Map<string, string>([
  ['api.anthropic.com', 'anthropic'],
  ['api.openai.com', 'openai'],
  ['api.github.com', 'github'],
  ['api.x.ai', 'xai'],
  ['gateway.ai.cloudflare.com', 'cloudflare-ai'],
  ['api.mistral.ai', 'mistral'],
  ['api-inference.huggingface.co', 'huggingface'],
  ['slack.com', 'slack'],
  ['*.slack.com', 'slack'],
  ['discord.com', 'discord'],
  ['*.discord.com', 'discord'],
  ['api.telegram.org', 'telegram'],
  ['matrix.org', 'matrix'],
  ['*.matrix.org', 'matrix'],
  ['api.line.me', 'line'],
  ['api-data.line.me', 'line'],
  ['api.twitch.tv', 'twitch'],
  ['id.twitch.tv', 'twitch'],
  ['api.twilio.com', 'twilio'],
  ['*.twilio.com', 'twilio'],
  ['api.telnyx.com', 'telnyx'],
  ['api.elevenlabs.io', 'elevenlabs'],
  ['openapi.zalo.me', 'zalo'],
  ['graph.microsoft.com', 'ms-teams'],
  ['open.feishu.cn', 'feishu'],
  ['open.larksuite.com', 'feishu'],
  ['chat.googleapis.com', 'google-chat'],
]);

/**
 * Check if aquaman proxy binary is available (local node_modules or PATH)
 */
function isAquamanProxyInstalled(): boolean {
  return findAquamanProxyBinary() !== null;
}

/**
 * Start the aquaman proxy daemon using ProxyManager
 */
async function startProxy(log: OpenClawPluginApi["logger"]): Promise<boolean> {
  try {
    const mgr = createProxyManager({
      config: {},
      onReady: (info) => {
        socketPath = info.socketPath;
        if (info.hostMap && typeof info.hostMap === "object") {
          dynamicHostMap = new Map(Object.entries(info.hostMap));
        }
      },
      onError: (err) => log.error(`Proxy error: ${err.message}`),
      onExit: (code) => {
        proxyManager = null;
        log.warn(`Proxy exited with code ${code}`);
      },
    });
    await mgr.start();
    proxyManager = mgr;
    socketPath = mgr.getSocketPath();
    return true;
  } catch (err) {
    log.error(`Failed to start proxy: ${err}`);
    return false;
  }
}

/**
 * Stop the proxy daemon and deactivate the HTTP interceptor
 */
function stopProxy(): void {
  if (httpInterceptor) {
    httpInterceptor.deactivate();
    httpInterceptor = null;
  }
  if (proxyManager) {
    proxyManager.stop();
    proxyManager = null;
  }
  socketPath = null;
}

/**
 * Activate the HTTP interceptor to redirect channel API traffic through the proxy.
 * This is what provides credential isolation for channels that don't support base URL overrides.
 */
function activateHttpInterceptor(log: OpenClawPluginApi["logger"]): void {
  if (!socketPath) {
    log.error("Cannot activate HTTP interceptor: no socket path");
    return;
  }

  // Use dynamic host map from proxy (includes custom services from services.yaml)
  // Falls back to builtin map for backward compatibility
  const hostMap = dynamicHostMap || FALLBACK_HOST_MAP;

  httpInterceptor = createHttpInterceptor({
    socketPath,
    hostMap,
    log: (msg) => log.info(msg),
  });

  httpInterceptor.activate();
  log.info(`HTTP interceptor active: ${hostMap.size} host patterns redirected through proxy`);
}

/**
 * Set environment variables for SDK clients using sentinel hostname
 */
function configureEnvironment(log: OpenClawPluginApi["logger"], services: string[]): void {
  for (const service of services) {
    const serviceUrl = `http://aquaman.local/${service}`;

    switch (service) {
      case "anthropic":
        process.env["ANTHROPIC_BASE_URL"] = serviceUrl;
        log.info(`Set ANTHROPIC_BASE_URL=${serviceUrl}`);
        break;
      case "openai":
        process.env["OPENAI_BASE_URL"] = serviceUrl;
        log.info(`Set OPENAI_BASE_URL=${serviceUrl}`);
        break;
      case "github":
        process.env["GITHUB_API_URL"] = serviceUrl;
        log.info(`Set GITHUB_API_URL=${serviceUrl}`);
        break;
      default:
        const envKey = `${service.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
        process.env[envKey] = serviceUrl;
        log.info(`Set ${envKey}=${serviceUrl}`);
    }
  }
}

/**
 * Build status object for both the tool and slash command
 */
function getStatus(services: string[]) {
  const cliInstalled = isAquamanProxyInstalled();
  return {
    cliInstalled,
    proxyRunning: proxyManager !== null,
    socketPath: socketPath || getDefaultSocketPath(),
    services,
    httpInterceptorActive: httpInterceptor?.isActive() ?? false,
    ...(cliInstalled ? {} : { fix: "Run: npm install -g aquaman-proxy && aquaman setup" }),
    ...(!cliInstalled ? {} : proxyManager === null ? { fix: "Run: aquaman setup (or: openclaw aquaman setup)" } : {}),
    environmentVariables: Object.fromEntries(
      services.map((s) => {
        const key =
          s === "anthropic"
            ? "ANTHROPIC_BASE_URL"
            : s === "openai"
              ? "OPENAI_BASE_URL"
              : `${s.toUpperCase()}_BASE_URL`;
        return [key, process.env[key] ?? null];
      })
    ),
  };
}

/**
 * Register the aquaman_status tool — always registered (works in degraded mode)
 */
function registerStatusTool(api: OpenClawPluginApi, services: string[]): void {
  api.registerTool(
    () => {
      return {
        name: "aquaman_status",
        label: "Aquaman Status",
        description:
          "Check aquaman credential proxy status and configured services",
        parameters: {
          type: "object" as const,
          properties: {},
          required: [] as string[],
        },
        async execute(_toolCallId: string, _params: unknown) {
          const status = getStatus(services);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
            details: status,
          };
        },
      };
    },
    { names: ["aquaman_status"] }
  );
}

/**
 * Auto-generate auth-profiles.json with placeholder keys for proxied services.
 * OpenClaw checks its auth store before making API calls — without a placeholder
 * key, requests are rejected before they ever reach the proxy.
 */
function ensureAuthProfiles(log: OpenClawPluginApi["logger"], services: string[]): void {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ||
    path.join(os.homedir(), ".openclaw");
  const profilesPath = path.join(
    stateDir,
    "agents",
    "main",
    "agent",
    "auth-profiles.json"
  );

  if (fs.existsSync(profilesPath)) return;

  const profiles: Record<string, any> = {};
  const order: Record<string, string[]> = {};

  for (const service of services) {
    if (service === "anthropic" || service === "openai") {
      profiles[`${service}:default`] = {
        type: "api_key",
        provider: service,
        key: "aquaman-proxy-managed",
      };
      order[service] = [`${service}:default`];
    }
  }

  const dir = path.dirname(profilesPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 1, profiles, order }, null, 2),
    { mode: 0o600 }
  );
  log.info(
    `Generated auth-profiles.json with placeholder keys at ${profilesPath}`
  );
}

/**
 * Aquaman OpenClaw Plugin Definition
 */
const plugin: OpenClawPluginDefinition = {
  id: 'aquaman-plugin',
  name: 'Aquaman — API Key Protection',
  version: PLUGIN_VERSION,
  description: 'API key protection for OpenClaw — credentials stay in your vault, never in the agent\'s memory',

  register(api) {
    api.logger.info("Aquaman plugin loaded");

    // Read services from plugin config
    const pluginCfg = api.pluginConfig as { backend?: string; services?: string[] } | undefined;
    configuredServices = pluginCfg?.services ?? ["anthropic", "openai"];

    // Auto-generate auth-profiles.json if missing
    ensureAuthProfiles(api.logger, configuredServices);

    // Check if aquaman proxy binary is available
    const proxyAvailable = isAquamanProxyInstalled();

    if (!proxyAvailable) {
      api.logger.warn(
        "aquaman proxy not found. Install with: npm install -g aquaman-proxy"
      );
      api.logger.warn(
        "Then run: aquaman setup"
      );
      // DO NOT call configureEnvironment() — sentinel URLs without a proxy
      // would break all API calls (connection refused to non-existent socket)
    } else {
      api.logger.info("aquaman proxy found, will start proxy on gateway start");

      // Configure environment variables immediately (sentinel hostname)
      configureEnvironment(api.logger, configuredServices);

      // Register service for proxy lifecycle management
      api.registerService({
        id: 'aquaman-proxy',
        async start(ctx) {
          ctx.logger.info("Starting aquaman proxy...");

          const started = await startProxy(ctx.logger);
          if (started && socketPath) {
            ctx.logger.info("Aquaman proxy started successfully");

            // Check for version mismatch between plugin and proxy
            const proxyVersion = await getProxyVersion(socketPath);
            if (proxyVersion && proxyVersion !== PLUGIN_VERSION) {
              ctx.logger.warn(
                `Warning: plugin version ${PLUGIN_VERSION} \u2260 proxy version ${proxyVersion}. ` +
                `Update both: npm install -g aquaman-proxy && openclaw plugins install aquaman-plugin`
              );
            }

            // Activate HTTP interceptor to redirect channel traffic through proxy
            activateHttpInterceptor(ctx.logger);
          } else {
            ctx.logger.error("Failed to start aquaman proxy");
            // Check if another instance is already running
            const defaultSock = getDefaultSocketPath();
            const alreadyRunning = await isProxyRunning(defaultSock);
            if (alreadyRunning) {
              socketPath = defaultSock;
              ctx.logger.info(
                "Another aquaman instance is already running — using it"
              );
              // Load host map from existing proxy
              const map = await loadHostMap(defaultSock);
              dynamicHostMap = map.size > 0 ? map : FALLBACK_HOST_MAP;
              activateHttpInterceptor(ctx.logger);
            } else {
              ctx.logger.error(
                "No running proxy found. Check: openclaw aquaman doctor"
              );
            }
          }
        },
        async stop(ctx) {
          ctx.logger.info("Stopping aquaman proxy...");
          stopProxy();
        }
      });
    }

    // --- Commands, tools, and CLI are ALWAYS registered (even without proxy) ---
    // This ensures ClawHub users who installed the plugin but haven't run setup
    // still get actionable commands and status information.

    // Register /aquaman-status slash command for humans
    api.registerCommand({
      name: 'aquaman-status',
      description: 'Show aquaman credential proxy status and configured services',
      acceptsArgs: false,
      requireAuth: true,
      async handler() {
        const status = getStatus(configuredServices);
        return { text: JSON.stringify(status, null, 2) };
      }
    });

    // Register CLI commands if available
    if (api.registerCli) {
      api.registerCli(
        ({ program }) => {
          const aquamanCmd = program
            .command("aquaman")
            .description("Aquaman — API key protection");

          aquamanCmd
            .command("status")
            .description("Show aquaman proxy status")
            .action(() => {
              const status = getStatus(configuredServices);
              console.log("\nAquaman Status:");
              console.log(`  Proxy binary: ${status.cliInstalled ? "found" : "NOT FOUND"}`);
              console.log(`  Proxy running: ${status.proxyRunning}`);
              console.log(`  Socket path: ${status.socketPath}`);
              console.log(`  Services: ${configuredServices.join(", ")}`);
              if (status.fix) {
                console.log(`\n  Action needed: ${status.fix}`);
              }
              if (status.proxyRunning) {
                console.log("\nEnvironment Variables:");
                for (const service of configuredServices) {
                  const envKey =
                    service === "anthropic"
                      ? "ANTHROPIC_BASE_URL"
                      : service === "openai"
                        ? "OPENAI_BASE_URL"
                        : `${service.toUpperCase()}_BASE_URL`;
                  console.log(`  ${envKey}=${process.env[envKey] ?? "(not set)"}`);
                }
              }
            });

          aquamanCmd
            .command("setup")
            .description("Run the setup wizard (stores keys, configures backend)")
            .action(async () => {
              try {
                const exitCode = await execAquamanProxyInteractive(['setup']);
                if (exitCode !== 0) process.exitCode = exitCode;
              } catch {
                console.log("\n  Run in your terminal:\n    aquaman setup\n");
              }
            });

          aquamanCmd
            .command("doctor")
            .description("Diagnose issues with actionable fixes")
            .action(async () => {
              try {
                const result = await execAquamanProxyCli(['doctor']);
                process.stdout.write(result.stdout);
                if (result.stderr) process.stderr.write(result.stderr);
                if (result.exitCode !== 0) process.exitCode = result.exitCode;
              } catch (err: any) {
                console.error(`Failed to run aquaman doctor: ${err.message}`);
                process.exitCode = 1;
              }
            });

          const credsCmd = aquamanCmd
            .command("credentials")
            .description("Credential management");

          credsCmd
            .command("list")
            .description("List stored credentials")
            .action(async () => {
              try {
                const result = await execAquamanProxyCli(['credentials', 'list']);
                process.stdout.write(result.stdout);
                if (result.stderr) process.stderr.write(result.stderr);
              } catch (err: any) {
                console.error(`Failed: ${err.message}`);
              }
            });

          credsCmd
            .command("add <service> [key]")
            .description("Add a credential (secure prompt)")
            .action(async (service: string, key: string = "api_key") => {
              try {
                const exitCode = await execAquamanProxyInteractive(['credentials', 'add', service, key]);
                if (exitCode !== 0) process.exitCode = exitCode;
              } catch {
                console.log(`\n  Run in your terminal:\n    aquaman credentials add ${service} ${key}\n`);
              }
            });

          aquamanCmd
            .command("policy-list")
            .description("List configured request policy rules")
            .action(async () => {
              try {
                const result = await execAquamanProxyCli(['policy', 'list']);
                process.stdout.write(result.stdout);
                if (result.stderr) process.stderr.write(result.stderr);
              } catch (err: any) {
                console.error(`Failed: ${err.message}`);
              }
            });

          aquamanCmd
            .command("audit-tail")
            .description("Show recent audit log entries")
            .action(async () => {
              try {
                const result = await execAquamanProxyCli(['audit', 'tail']);
                process.stdout.write(result.stdout);
                if (result.stderr) process.stderr.write(result.stderr);
              } catch (err: any) {
                console.error(`Failed: ${err.message}`);
              }
            });

          aquamanCmd
            .command("services-list")
            .description("List all configured services")
            .action(async () => {
              try {
                const result = await execAquamanProxyCli(['services', 'list']);
                process.stdout.write(result.stdout);
                if (result.stderr) process.stderr.write(result.stderr);
              } catch (err: any) {
                console.error(`Failed: ${err.message}`);
              }
            });
        },
        { commands: ["aquaman"] }
      );
    }

    registerStatusTool(api, configuredServices);
    api.logger.info("Aquaman plugin registered successfully");
  }
};

export default plugin;
