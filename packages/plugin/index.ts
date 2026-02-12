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
 *   - Set ANTHROPIC_BASE_URL, OPENAI_BASE_URL etc. to route through proxy
 *   - The proxy injects credentials into requests
 *   - Agent never sees the actual API keys
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HttpInterceptor, createHttpInterceptor } from "./src/http-interceptor.js";
import { createProxyManager, type ProxyManager } from "./src/proxy-manager.js";
import { fetchHostMap, isProxyRunning, getProxyVersion } from "./src/proxy-health.js";

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
let clientToken: string | null = null;
let dynamicHostMap: Map<string, string> | null = null;
const proxyPort = 8081;
const services = ["anthropic", "openai"];

/** Fallback host map used when proxy doesn't provide one (backward compat) */
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
 * Get external proxy URL from environment (for Docker two-container mode).
 * When set, the plugin skips spawning a local proxy and routes traffic to the external URL.
 */
function getExternalProxyUrl(): string | null {
  return process.env.AQUAMAN_PROXY_URL || null;
}

/**
 * Get external client token from environment (for Docker two-container mode).
 */
function getExternalClientToken(): string | null {
  return process.env.AQUAMAN_CLIENT_TOKEN || null;
}

/**
 * Check if aquaman CLI is installed (fs-based, no shell execution)
 */
function isAquamanInstalled(): boolean {
  return findInPath("aquaman") !== null;
}

/**
 * Start the aquaman proxy daemon using ProxyManager
 */
async function startProxy(port: number, log: OpenClawPluginApi["logger"]): Promise<boolean> {
  try {
    const mgr = createProxyManager({
      config: { proxyPort: port },
      onReady: (info) => {
        clientToken = info.token || null;
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
  clientToken = null;
}

/**
 * Activate the HTTP interceptor to redirect channel API traffic through the proxy.
 * This is what provides credential isolation for channels that don't support base URL overrides.
 */
function activateHttpInterceptor(log: OpenClawPluginApi["logger"]): void {
  // Use dynamic host map from proxy (includes custom services from services.yaml)
  // Falls back to builtin map for backward compatibility
  const hostMap = dynamicHostMap || FALLBACK_HOST_MAP;

  const baseUrl = getExternalProxyUrl() || `http://127.0.0.1:${proxyPort}`;

  httpInterceptor = createHttpInterceptor({
    proxyBaseUrl: baseUrl,
    hostMap,
    clientToken: clientToken || undefined,
    log: (msg) => log.info(msg),
  });

  httpInterceptor.activate();
  log.info(`HTTP interceptor active: ${hostMap.size} host patterns redirected through proxy`);
}

/**
 * Set environment variables for SDK clients
 */
function configureEnvironment(log: OpenClawPluginApi["logger"]): void {
  const baseUrl = getExternalProxyUrl() || `http://127.0.0.1:${proxyPort}`;

  for (const service of services) {
    const serviceUrl = `${baseUrl}/${service}`;

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
 * Register the aquaman_status tool (shared between local and external proxy modes)
 */
function registerStatusTool(api: OpenClawPluginApi): void {
  const externalUrl = getExternalProxyUrl();
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
            externalProxy: externalUrl !== null,
            proxyUrl: externalUrl || `http://127.0.0.1:${proxyPort}`,
            proxyRunning: externalUrl !== null || proxyManager !== null,
            proxyPort,
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
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 1, profiles, order }, null, 2)
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

  const externalUrl = getExternalProxyUrl();

  // External proxy mode (Docker two-container architecture)
  if (externalUrl) {
    api.logger.info(`External proxy mode: ${externalUrl}`);
    clientToken = getExternalClientToken();
    configureEnvironment(api.logger);

    if (api.registerLifecycle) {
      api.registerLifecycle({
        async onGatewayStart() {
          // Fetch dynamic host map from external proxy (includes custom services)
          const map = await fetchHostMap(externalUrl, clientToken);
          dynamicHostMap = map.size > 0 ? map : FALLBACK_HOST_MAP;
          activateHttpInterceptor(api.logger);
          api.logger.info("HTTP interceptor active (external proxy mode)");
        },
        async onGatewayStop() {
          if (httpInterceptor) {
            httpInterceptor.deactivate();
            httpInterceptor = null;
          }
        },
      });
    }

    registerStatusTool(api);
    api.logger.info("Aquaman plugin registered successfully");
    return;
  }

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

  // Configure environment variables immediately
  configureEnvironment(api.logger);

  // Register lifecycle hooks if available
  if (api.registerLifecycle) {
    api.registerLifecycle({
      async onGatewayStart() {
        api.logger.info(`Starting aquaman proxy on port ${proxyPort}...`);

        const started = await startProxy(proxyPort, api.logger);
        if (started) {
          api.logger.info("Aquaman proxy started successfully");

          // Check for version mismatch between plugin and proxy
          const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;
          const proxyVersion = await getProxyVersion(proxyBaseUrl);
          if (proxyVersion && proxyVersion !== PLUGIN_VERSION) {
            api.logger.warn(
              `Warning: plugin version ${PLUGIN_VERSION} \u2260 proxy version ${proxyVersion}. ` +
              `Update both: npm install -g aquaman-proxy && openclaw plugins install aquaman-plugin`
            );
          }

          // Activate HTTP interceptor to redirect channel traffic through proxy
          activateHttpInterceptor(api.logger);
        } else {
          api.logger.error(
            `Failed to start aquaman proxy on port ${proxyPort}`
          );
          // Check if another instance is already running on the port
          const alreadyRunning = await isProxyRunning(proxyPort);
          if (alreadyRunning) {
            api.logger.info(
              `Another aquaman instance is already running on port ${proxyPort} — using it`
            );
            activateHttpInterceptor(api.logger);
          } else {
            api.logger.error(
              `Port ${proxyPort} may be in use. Check with: lsof -i :${proxyPort}`
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
            console.log(`  Proxy port: ${proxyPort}`);
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
