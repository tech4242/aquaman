/**
 * Claude Code hook handler.
 *
 * Claude Code's hook contract:
 *   - The hook receives a JSON event on stdin.
 *   - It responds with a JSON decision on stdout.
 *   - Exit code 2 blocks the action.
 *
 * We handle two event types in v0.12.0:
 *
 *   PreToolUse: for Bash tool calls we resolve any aquaman:// env
 *     references for the matching project and emit
 *     `{ hookSpecificOutput: { hookEventName: "PreToolUse",
 *        additionalEnvVars: {...} } }`
 *     so Claude Code injects them just for that one invocation. No
 *     persistent shell state.
 *
 *   PostToolUse: we redact tool output via the aquaman-core redactor
 *     so any secrets accidentally leaked by the tool are scrubbed
 *     before they enter the model's context.
 */

import { redact } from 'aquaman-proxy';
import { findProjectForCwd, loadProjects, parseRef } from '../../projects.js';
import { BrokerClient } from '../../broker-client.js';

export interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  cwd?: string;
}

export interface HookDecision {
  hookSpecificOutput?: Record<string, unknown>;
  decision?: 'block' | 'approve';
  reason?: string;
}

export interface HookContext {
  /** Override for testing. Defaults to BrokerClient with default UDS. */
  broker?: BrokerClient;
  /** Override projects.yaml path for testing. */
  projectsPath?: string;
}

export async function handlePreToolUse(
  event: HookEvent,
  ctx: HookContext = {}
): Promise<HookDecision | null> {
  if (event.tool_name !== 'Bash') return null;
  const cwd = event.cwd || process.cwd();

  const projects = loadProjects(ctx.projectsPath);
  const match = findProjectForCwd(cwd, projects);
  if (!match) return null;

  const broker = ctx.broker ?? new BrokerClient();
  const additionalEnvVars: Record<string, string> = {};

  for (const [envName, ref] of Object.entries(match.config.env)) {
    const parsed = parseRef(ref);
    if (!parsed) continue;
    try {
      const result = await broker.resolve({
        service: parsed.service,
        key: parsed.key,
        ttlSeconds: 60,
      });
      additionalEnvVars[envName] = result.value;
    } catch (err) {
      // Surface the error to Claude Code as a blocking reason — better to
      // fail loud than silently run a command that the user expected to
      // have credentials.
      return {
        decision: 'block',
        reason: `aquaman: failed to resolve ${envName} (${ref}): ${(err as Error).message}`,
      };
    }
  }

  if (Object.keys(additionalEnvVars).length === 0) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalEnvVars,
    },
  };
}

export function handlePostToolUse(event: HookEvent): HookDecision | null {
  if (event.tool_output === undefined || event.tool_output === null) return null;

  // Walk the output and redact strings. Returns a modified body that
  // Claude Code splices back in if `hookSpecificOutput.updatedToolOutput`
  // is set (post-tool-use is currently advisory-only in Claude Code <1.0
  // but we emit the same shape forward-compatibly).
  const text = typeof event.tool_output === 'string'
    ? event.tool_output
    : JSON.stringify(event.tool_output);
  const { output, findings } = redact(text);

  if (findings.length === 0) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: output,
      aquamanFindings: findings,
    },
  };
}

/**
 * Stdio entry point: read JSON from stdin, dispatch by hook_event_name,
 * write decision to stdout. Exits 2 to block.
 */
export async function runHookFromStdin(
  argv: string[],
  ctx: HookContext = {}
): Promise<number> {
  let stdin = '';
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }

  let event: HookEvent;
  try {
    event = JSON.parse(stdin);
  } catch (err) {
    process.stderr.write(`aquaman-coder: malformed hook input: ${(err as Error).message}\n`);
    return 1;
  }

  let decision: HookDecision | null = null;
  switch (event.hook_event_name) {
    case 'PreToolUse':
      decision = await handlePreToolUse(event, ctx);
      break;
    case 'PostToolUse':
      decision = handlePostToolUse(event);
      break;
    default:
      // No-op for unknown events — let Claude Code proceed.
      return 0;
  }

  if (!decision) return 0;

  process.stdout.write(JSON.stringify(decision));
  if (decision.decision === 'block') return 2;
  return 0;
}
