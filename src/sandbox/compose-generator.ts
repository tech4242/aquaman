/**
 * Docker Compose configuration generator for sandboxed OpenClaw
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import type { WrapperConfig } from '../types.js';
import { getConfigDir, expandPath } from '../utils/config.js';

export interface ComposeConfig {
  version: string;
  services: {
    aquaman: ServiceConfig;
    openclaw: ServiceConfig;
  };
  networks: {
    aquaman_net: NetworkConfig;
  };
}

interface ServiceConfig {
  image: string;
  container_name: string;
  build?: {
    context: string;
    dockerfile: string;
  };
  volumes: string[];
  networks: string[];
  environment: string[];
  ports?: string[];
  depends_on?: Record<string, { condition: string }>;
  deploy?: {
    resources: {
      limits: {
        cpus: string;
        memory: string;
      };
    };
  };
  working_dir?: string;
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
  };
}

interface NetworkConfig {
  driver: string;
  internal: boolean;
  ipam?: {
    config: Array<{ subnet: string }>;
  };
}

export function generateComposeConfig(config: WrapperConfig): ComposeConfig {
  const sandbox = config.sandbox;
  const workspaceHost = expandPath(sandbox.workspace.hostPath);
  const workspaceContainer = sandbox.workspace.containerPath;
  const readOnlyFlag = sandbox.workspace.readOnly ? 'ro' : 'rw';

  // Build environment variables for OpenClaw
  const openclawEnv = [
    // Point to aquaman proxies
    'ANTHROPIC_BASE_URL=http://aquaman:8081/anthropic',
    'OPENAI_BASE_URL=http://aquaman:8081/openai',
    // Gateway configuration
    'OPENCLAW_GATEWAY_HOST=aquaman',
    `OPENCLAW_GATEWAY_PORT=${config.wrapper.proxyPort}`,
    // Disable direct credential loading
    'OPENCLAW_NO_CREDENTIALS=true',
  ];

  // Enable OpenClaw's internal sandbox if configured
  if (sandbox.enableOpenclawSandbox) {
    openclawEnv.push('OPENCLAW_SANDBOX_MODE=non-main');
  }

  // Add custom environment variables
  if (sandbox.environment) {
    for (const [key, value] of Object.entries(sandbox.environment)) {
      openclawEnv.push(`${key}=${value}`);
    }
  }

  const composeConfig: ComposeConfig = {
    version: '3.8',
    services: {
      aquaman: {
        image: 'aquaman-clawed:local',
        container_name: 'aquaman-control-plane',
        build: {
          context: '.',
          dockerfile: 'docker/Dockerfile.aquaman'
        },
        volumes: [
          // Mount aquaman config (read-only)
          `${getConfigDir()}:/root/.aquaman:ro`
        ],
        networks: ['aquaman_net'],
        // Only expose approval API to host for CLI interaction
        ports: [`127.0.0.1:18791:18791`],
        environment: [
          'AQUAMAN_SANDBOX_MODE=true',
          'AQUAMAN_BIND_ADDRESS=0.0.0.0'
        ],
        healthcheck: {
          test: ['CMD', 'wget', '-q', '--spider', 'http://localhost:18791/pending'],
          interval: '10s',
          timeout: '5s',
          retries: 3
        }
      },
      openclaw: {
        image: sandbox.openclawImage,
        container_name: 'openclaw-sandboxed',
        depends_on: {
          aquaman: { condition: 'service_healthy' }
        },
        volumes: [
          `${workspaceHost}:${workspaceContainer}:${readOnlyFlag}`
          // NO credential mounts - this is critical for isolation
        ],
        networks: ['aquaman_net'],
        environment: openclawEnv,
        working_dir: workspaceContainer
      }
    },
    networks: {
      aquaman_net: {
        driver: 'bridge',
        internal: true, // CRITICAL: No external network access
        ipam: {
          config: [{ subnet: '172.28.0.0/16' }]
        }
      }
    }
  };

  // Add resource limits if configured
  if (sandbox.resources) {
    composeConfig.services.openclaw.deploy = {
      resources: {
        limits: {
          cpus: sandbox.resources.cpus || '2',
          memory: sandbox.resources.memory || '4g'
        }
      }
    };
  }

  return composeConfig;
}

export function writeComposeFile(config: ComposeConfig, outputPath: string): void {
  const yaml = yamlStringify(config, { indent: 2 });
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, yaml, 'utf-8');
}

export function getDefaultComposePath(): string {
  return path.join(os.tmpdir(), 'aquaman-sandbox', 'docker-compose.yml');
}
