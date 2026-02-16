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

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HttpInterceptor, createHttpInterceptor } from "./src/http-interceptor.js";
import { createProxyManager, type ProxyManager } from "./src/proxy-manager.js";
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
const services = ["anthropic", "openai"];

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
 * Check if aquaman CLI is installed (fs-based, no shell execution)
 */
function isAquamanInstalled(): boolean {
  return findInPath("aquaman") !== null;
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
function configureEnvironment(log: OpenClawPluginApi["logger"]): void {
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
 * Register the aquaman_status tool
 */
function registerStatusTool(api: OpenClawPluginApi): void {
  api.registerTool(
    () => {
      return {
        name: "aquaman_status",
        description:
          "Check aquaman credential proxy status and configured services",
        parameters: {
          type: "object" as const,
          properties: {},
          required: [] as string[],
        },
        async execute() {
          return {
            proxyRunning: proxyManager !== null,
            socketPath: socketPath || getDefaultSocketPath(),
            services,
            httpInterceptorActive: httpInterceptor?.isActive() ?? false,
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
function ensureAuthProfiles(log: OpenClawPluginApi["logger"]): void {
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
 * OpenClaw plugin register function
 */
export default function register(api: OpenClawPluginApi): void {
  api.logger.info("Aquaman plugin loaded");

  // Auto-generate auth-profiles.json if missing
  ensureAuthProfiles(api.logger);

  // Local proxy mode — requires aquaman CLI
  if (!isAquamanInstalled()) {
    api.logger.warn(
      "aquaman CLI not found. Install with: npm install -g aquaman-proxy"
    );
    api.logger.warn(
      "Then run: aquaman setup"
    );
    configureEnvironment(api.logger);
    return;
  }

  api.logger.info("aquaman CLI found, will start proxy on gateway start");

  // Configure environment variables immediately (sentinel hostname)
  configureEnvironment(api.logger);

  // Register lifecycle hooks if available
  if (api.registerLifecycle) {
    api.registerLifecycle({
      async onGatewayStart() {
        api.logger.info("Starting aquaman proxy...");

        const started = await startProxy(api.logger);
        if (started && socketPath) {
          api.logger.info("Aquaman proxy started successfully");

          // Check for version mismatch between plugin and proxy
          const proxyVersion = await getProxyVersion(socketPath);
          if (proxyVersion && proxyVersion !== PLUGIN_VERSION) {
            api.logger.warn(
              `Warning: plugin version ${PLUGIN_VERSION} \u2260 proxy version ${proxyVersion}. ` +
              `Update both: npm install -g aquaman-proxy && openclaw plugins install aquaman-plugin`
            );
          }

          // Activate HTTP interceptor to redirect channel traffic through proxy
          activateHttpInterceptor(api.logger);
        } else {
          api.logger.error("Failed to start aquaman proxy");
          // Check if another instance is already running
          const defaultSock = getDefaultSocketPath();
          const alreadyRunning = await isProxyRunning(defaultSock);
          if (alreadyRunning) {
            socketPath = defaultSock;
            api.logger.info(
              "Another aquaman instance is already running — using it"
            );
            // Load host map from existing proxy
            const map = await loadHostMap(defaultSock);
            dynamicHostMap = map.size > 0 ? map : FALLBACK_HOST_MAP;
            activateHttpInterceptor(api.logger);
          } else {
            api.logger.error(
              "No running proxy found. Check: aquaman doctor"
            );
          }
        }
      },

      async onGatewayStop() {
        api.logger.info("Stopping aquaman proxy...");
        stopProxy();
      },
    });
  }

  // Register CLI commands if available
  if (api.registerCli) {
    api.registerCli(
      ({ program }) => {
        const aquamanCmd = program
          .command("aquaman")
          .description("Aquaman credential management");

        aquamanCmd
          .command("status")
          .description("Show aquaman proxy status")
          .action(() => {
            console.log("\nAquaman Status:");
            console.log(`  Proxy running: ${proxyManager !== null}`);
            console.log(`  Socket path: ${socketPath || getDefaultSocketPath()}`);
            console.log(`  Services: ${services.join(", ")}`);
            console.log("\nEnvironment Variables:");
            for (const service of services) {
              const envKey =
                service === "anthropic"
                  ? "ANTHROPIC_BASE_URL"
                  : service === "openai"
                    ? "OPENAI_BASE_URL"
                    : `${service.toUpperCase()}_BASE_URL`;
              console.log(`  ${envKey}=${process.env[envKey] ?? "(not set)"}`);
            }
          });

        aquamanCmd
          .command("add <service> [key]")
          .description("Add a credential (opens secure prompt)")
          .action((service: string, key: string = "api_key") => {
            console.log(`\n  Run in your terminal:\n    aquaman credentials add ${service} ${key}\n`);
          });

        aquamanCmd
          .command("list")
          .description("List stored credentials")
          .action(() => {
            console.log(`\n  Run in your terminal:\n    aquaman credentials list\n`);
          });
      },
      { commands: ["aquaman"] }
    );
  }

  registerStatusTool(api);
  api.logger.info("Aquaman plugin registered successfully");
}
