/**
 * Aquaman OpenClaw Plugin
 *
 * Zero-trust credential isolation for OpenClaw.
 * Credentials never enter the agent process - they're managed by a separate proxy.
 *
 * Usage:
 *   1. Install aquaman: npm install -g @aquaman/proxy
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
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { HttpInterceptor, createHttpInterceptor } from "./src/http-interceptor.js";

let proxyProcess: ChildProcess | null = null;
let httpInterceptor: HttpInterceptor | null = null;
const proxyPort = 8081;
const services = ["anthropic", "openai"];

/**
 * Check if aquaman CLI is installed
 */
function isAquamanInstalled(): boolean {
  try {
    execSync("which aquaman", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the aquaman proxy daemon
 */
async function startProxy(port: number, log: OpenClawPluginApi["logger"]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      proxyProcess = spawn("aquaman", ["plugin-mode", "--port", String(port)], {
        stdio: "pipe",
        detached: false,
      });
    } catch (err) {
      log.error(`Failed to spawn aquaman: ${err}`);
      resolve(false);
      return;
    }

    let started = false;

    proxyProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      log.debug(`[aquaman] ${output.trim()}`);
      if (output.includes("listening") || output.includes("started")) {
        started = true;
        resolve(true);
      }
    });

    proxyProcess.stderr?.on("data", (data: Buffer) => {
      log.warn(`[aquaman] ${data.toString().trim()}`);
    });

    proxyProcess.on("error", (err) => {
      log.error(`Failed to start proxy: ${err.message}`);
      resolve(false);
    });

    proxyProcess.on("exit", (code) => {
      if (!started) {
        log.warn(`Proxy exited with code ${code} before starting`);
        resolve(false);
      }
      proxyProcess = null;
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      if (!started) {
        log.warn("Proxy start timed out");
        resolve(false);
      }
    }, 5000);
  });
}

/**
 * Stop the proxy daemon and deactivate the HTTP interceptor
 */
function stopProxy(): void {
  if (httpInterceptor) {
    httpInterceptor.deactivate();
    httpInterceptor = null;
  }
  if (proxyProcess) {
    proxyProcess.kill("SIGTERM");
    proxyProcess = null;
  }
}

/**
 * Activate the HTTP fetch interceptor to redirect channel API traffic through the proxy.
 * This is what provides credential isolation for channels that don't support base URL overrides.
 */
function activateHttpInterceptor(log: OpenClawPluginApi["logger"]): void {
  // Build host-to-service map for all known channel APIs
  const hostMap = new Map<string, string>([
    // LLM providers (also have env var overrides, but interceptor provides defense-in-depth)
    ['api.anthropic.com', 'anthropic'],
    ['api.openai.com', 'openai'],
    ['api.github.com', 'github'],
    // Channel APIs
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

  const baseUrl = `http://127.0.0.1:${proxyPort}`;

  httpInterceptor = createHttpInterceptor({
    proxyBaseUrl: baseUrl,
    hostMap,
    log: (msg) => log.info(msg),
  });

  httpInterceptor.activate();
  log.info(`HTTP interceptor active: ${hostMap.size} host patterns redirected through proxy`);
}

/**
 * Set environment variables for SDK clients
 */
function configureEnvironment(log: OpenClawPluginApi["logger"]): void {
  const baseUrl = `http://127.0.0.1:${proxyPort}`;

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
 * OpenClaw plugin register function
 */
export default function register(api: OpenClawPluginApi): void {
  api.logger.info("Aquaman plugin loaded");

  // Check if aquaman CLI is installed
  if (!isAquamanInstalled()) {
    api.logger.warn(
      "aquaman CLI not found. Install with: npm install -g @aquaman/proxy"
    );
    api.logger.warn(
      "Configuring environment variables, but credential injection requires the proxy to be running"
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
          // Activate fetch interceptor to redirect channel HTTP traffic through proxy
          activateHttpInterceptor(api.logger);
        } else {
          api.logger.error("Failed to start aquaman proxy");
          api.logger.warn("Run 'aquaman daemon' manually to enable credential injection");
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
            console.log(`  Proxy running: ${proxyProcess !== null}`);
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
            try {
              execSync(`aquaman credentials add ${service} ${key}`, {
                stdio: "inherit",
              });
            } catch {
              console.error(
                "Failed to add credential. Is aquaman installed? npm install -g @aquaman/proxy"
              );
            }
          });

        aquamanCmd
          .command("list")
          .description("List stored credentials")
          .action(() => {
            try {
              execSync("aquaman credentials list", { stdio: "inherit" });
            } catch {
              console.error(
                "Failed to list credentials. Is aquaman installed?"
              );
            }
          });
      },
      { commands: ["aquaman"] }
    );
  }

  // Register a tool for agents to check credential status
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
            proxyRunning: proxyProcess !== null,
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

  api.logger.info("Aquaman plugin registered successfully");
}
