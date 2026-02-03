/**
 * Docker Compose orchestrator for sandboxed OpenClaw
 * Manages the lifecycle of the containerized environment
 */

import { spawn, execSync, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WrapperConfig } from '../types.js';
import { generateComposeConfig, writeComposeFile, getDefaultComposePath } from './compose-generator.js';

export interface SandboxStatus {
  aquaman: 'running' | 'stopped' | 'unhealthy' | 'starting' | 'unknown';
  openclaw: 'running' | 'stopped' | 'starting' | 'unknown';
  network: 'created' | 'missing';
}

export interface StartOptions {
  detach?: boolean;
  build?: boolean;
}

export class SandboxOrchestrator {
  private config: WrapperConfig;
  private composeFile: string;
  private projectName = 'aquaman-sandbox';

  constructor(config: WrapperConfig) {
    this.config = config;
    this.composeFile = getDefaultComposePath();
  }

  /**
   * Start the sandboxed OpenClaw environment
   */
  async start(options: StartOptions = {}): Promise<void> {
    // Verify Docker is available
    this.verifyDocker();

    // Generate and write compose file
    const composeConfig = generateComposeConfig(this.config);
    writeComposeFile(composeConfig, this.composeFile);

    console.log(`Generated compose file: ${this.composeFile}`);

    // Build images if needed
    if (options.build !== false) {
      await this.buildImages();
    }

    // Start containers
    const args = [
      'compose',
      '-f', this.composeFile,
      '-p', this.projectName,
      'up'
    ];

    if (options.detach) {
      args.push('-d');
    }

    const spawnOptions: SpawnOptions = {
      stdio: options.detach ? 'pipe' : 'inherit',
      cwd: this.findProjectRoot()
    };

    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, spawnOptions);

      if (options.detach && child.stdout) {
        child.stdout.on('data', (data) => {
          process.stdout.write(data);
        });
      }

      if (options.detach && child.stderr) {
        child.stderr.on('data', (data) => {
          process.stderr.write(data);
        });
      }

      child.on('error', (error) => {
        reject(new Error(`Failed to start Docker: ${error.message}`));
      });

      child.on('exit', (code) => {
        if (code === 0 || options.detach) {
          resolve();
        } else {
          reject(new Error(`Docker compose exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Stop the sandboxed environment
   */
  async stop(): Promise<void> {
    const args = [
      'compose',
      '-f', this.composeFile,
      '-p', this.projectName,
      'down',
      '--remove-orphans'
    ];

    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: 'inherit' });

      child.on('error', (error) => {
        reject(new Error(`Failed to stop Docker: ${error.message}`));
      });

      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Docker compose down failed with code ${code}`));
        }
      });
    });
  }

  /**
   * Get status of the sandbox containers
   */
  async getStatus(): Promise<SandboxStatus> {
    const status: SandboxStatus = {
      aquaman: 'unknown',
      openclaw: 'unknown',
      network: 'missing'
    };

    try {
      // Check if compose file exists
      if (!fs.existsSync(this.composeFile)) {
        return status;
      }

      // Check container status
      const psOutput = execSync(
        `docker compose -f "${this.composeFile}" -p ${this.projectName} ps --format json 2>/dev/null || echo "[]"`,
        { encoding: 'utf-8' }
      ).trim();

      // Parse each line as a JSON object (docker outputs one per line)
      const lines = psOutput.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const container = JSON.parse(line);
          if (container.Service === 'aquaman') {
            if (container.State === 'running') {
              status.aquaman = container.Health === 'healthy' ? 'running' :
                              container.Health === 'starting' ? 'starting' : 'unhealthy';
            } else {
              status.aquaman = 'stopped';
            }
          }
          if (container.Service === 'openclaw') {
            status.openclaw = container.State === 'running' ? 'running' : 'stopped';
          }
        } catch {
          // Skip unparseable lines
        }
      }

      // Check network
      const networkOutput = execSync(
        `docker network ls --filter name=${this.projectName}_aquaman_net --format "{{.Name}}" 2>/dev/null || true`,
        { encoding: 'utf-8' }
      );

      status.network = networkOutput.trim() ? 'created' : 'missing';

    } catch {
      // Return unknown status on error
    }

    return status;
  }

  /**
   * Stream logs from containers
   */
  async logs(service?: 'aquaman' | 'openclaw', follow: boolean = false): Promise<void> {
    if (!fs.existsSync(this.composeFile)) {
      console.error('Sandbox not started. Run "aquaman start" first.');
      return;
    }

    const args = [
      'compose',
      '-f', this.composeFile,
      '-p', this.projectName,
      'logs'
    ];

    if (follow) {
      args.push('-f');
    }

    if (service) {
      args.push(service);
    }

    return new Promise((resolve) => {
      const child = spawn('docker', args, { stdio: 'inherit' });
      child.on('exit', () => resolve());
    });
  }

  /**
   * Verify Docker and Docker Compose are available
   */
  private verifyDocker(): void {
    try {
      execSync('docker --version', { stdio: 'ignore' });
    } catch {
      throw new Error(
        'Docker not found. Please install Docker Desktop or Docker Engine.\n' +
        'Visit: https://docs.docker.com/get-docker/'
      );
    }

    try {
      execSync('docker compose version', { stdio: 'ignore' });
    } catch {
      throw new Error(
        'Docker Compose not found. Please install Docker Compose V2.\n' +
        'Visit: https://docs.docker.com/compose/install/'
      );
    }

    // Check if Docker daemon is running
    try {
      execSync('docker info', { stdio: 'ignore' });
    } catch {
      throw new Error(
        'Docker daemon is not running. Please start Docker Desktop or the Docker service.'
      );
    }
  }

  /**
   * Build Docker images
   */
  private async buildImages(): Promise<void> {
    // Check if aquaman image exists
    try {
      execSync('docker image inspect aquaman-clawed:local', { stdio: 'ignore' });
      console.log('Using existing aquaman-clawed:local image');
      return;
    } catch {
      // Image doesn't exist, build it
    }

    console.log('Building aquaman-clawed Docker image...');

    const projectRoot = this.findProjectRoot();
    const dockerfilePath = path.join(projectRoot, 'docker', 'Dockerfile.aquaman');

    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(
        `Dockerfile not found: ${dockerfilePath}\n` +
        'Run "npm run build" first to ensure all files are in place.'
      );
    }

    return new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'build',
        '-t', 'aquaman-clawed:local',
        '-f', dockerfilePath,
        projectRoot
      ], { stdio: 'inherit' });

      child.on('error', (error) => {
        reject(new Error(`Failed to build image: ${error.message}`));
      });

      child.on('exit', (code) => {
        if (code === 0) {
          console.log('Image built successfully');
          resolve();
        } else {
          reject(new Error('Failed to build aquaman-clawed Docker image'));
        }
      });
    });
  }

  /**
   * Find the project root directory
   */
  private findProjectRoot(): string {
    // Start from this file's directory and work up
    let dir = path.dirname(new URL(import.meta.url).pathname);

    // Handle Windows paths
    if (process.platform === 'win32' && dir.startsWith('/')) {
      dir = dir.slice(1);
    }

    while (dir !== '/' && dir !== '') {
      const packagePath = path.join(dir, 'package.json');
      if (fs.existsSync(packagePath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
          if (pkg.name === 'aquaman-clawed') {
            return dir;
          }
        } catch {
          // Continue searching
        }
      }
      dir = path.dirname(dir);
    }

    // Fallback to cwd
    return process.cwd();
  }

  /**
   * Get path to compose file
   */
  getComposeFilePath(): string {
    return this.composeFile;
  }
}

export function createSandboxOrchestrator(config: WrapperConfig): SandboxOrchestrator {
  return new SandboxOrchestrator(config);
}
