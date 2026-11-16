/**
 * Claude Code hook handler.
 *
 * Claude Code's hook protocol (verified against https://code.claude.com/docs/en/hooks):
 *   - The hook receives a JSON event on stdin.
 *   - Structured decisions: write JSON to stdout, exit 0.
 *   - Blocking errors: write a message to stderr, exit 2.
 *
 * PreToolUse hookSpecificOutput supports `permissionDecision`,
 * `permissionDecisionReason`, `updatedInput`, and `additionalContext`.
 * There is NO env-injection API on PreToolUse — to scope credentials
 * to a single tool call we rewrite the Bash command itself via
 * `updatedInput.command` to invoke it under `aquaman-coder exec`,
 * which runs the broker resolve + redaction pipeline server-side.
 *
 * PostToolUse hookSpecificOutput supports `additionalContext` and — since
 * Claude Code ~2.1.170 (verified stable through 2.1.215, 2026-07-19) —
 * `updatedToolOutput`, which rewrites the tool output before it reaches
 * the transcript. We run the redactor over every tool's output (Read /
 * Grep / Glob surfacing on-disk secrets, unwrapped Bash, MCP tools) and
 * rewrite in place. This is defense-in-depth on top of `aquaman-coder
 * exec`'s stdout/stderr scrubbing: the exec wrapper knows the literal
 * injected values (value-based redaction), the hook covers shape-based
 * patterns for outputs that never passed through the wrapper. Set
 * AQUAMAN_DISABLE_OUTPUT_REWRITE=1 to fall back to warning-only on
 * pre-2.1.170 Claude Code versions that don't know the field.
 */

// Note: imported from `aquaman-proxy` (which re-exports from its
// merged core/). There is no separate `aquaman-core` npm package since
// v0.7.0; the vitest alias resolves the same path for tests.
import { redact, redactDeep } from 'aquaman-proxy';
import { findProjectForCwd, loadProjects, parseRef } from '../../projects.js';
import { BrokerClient } from '../../broker-client.js';
import { handleCodexPreToolUse, handleCodexPostToolUse } from '../codex/hook.js';

export interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
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
  /**
   * Wrapper command prefix injected into Bash commands. Default
   * `aquaman-coder exec --` — change in tests to assert the rewrite.
   */
  wrapperPrefix?: string;
  /**
   * Disable PostToolUse `updatedToolOutput` rewriting (fall back to the
   * warning-only additionalContext behavior for Claude Code < 2.1.170).
   * Defaults to the AQUAMAN_DISABLE_OUTPUT_REWRITE env var.
   */
  disableOutputRewrite?: boolean;
  /**
   * Which host invoked the hook. Codex (v0.16.0+) shares the event shape but
   * not every output field, so its handlers live in adapters/codex/hook.ts.
   */
  host?: 'claude-code' | 'codex';
}

// Default wrapper uses the direct binary form (`aquaman-coder exec`) rather
// than the unified-CLI form (`aquaman coder exec`) to skip the shim's
// process-spawn overhead on every Bash tool call. Both forms work; the
// rewrite check below matches either so manually-wrapped commands aren't
// double-wrapped.
const DEFAULT_WRAPPER = 'aquaman-coder exec --';
const AQUAMAN_WRAPPER_MARKS = ['aquaman-coder exec', 'aquaman coder exec'];

/**
 * Keep the user's Bash permission rules working on a rewritten command.
 *
 * Since Claude Code 2.1.290 permission rules are evaluated against the input
 * the hook returns, not the command Claude wrote, and a rule never looks
 * inside `sh -c '...'`. A bare wrapper would hide the real command from every
 * deny and ask rule (verified live on 2.1.325).
 *
 * So the original command stays in the rewritten text as its own top-level
 * statement, after an unconditional `exit`. Claude Code splits the
 * text into subcommands and matches its rules against each, so a deny or ask
 * rule on the original fires exactly as the host would have applied it, from
 * every rule source (settings files, managed policy, CLI flags, session
 * rules) and with the host's own matcher. The shell never reaches the tail:
 * `exit` is a builtin, runs whether the wrapper succeeded or could not start,
 * and with no argument carries the wrapper's status. (Not `exit $?`: Claude
 * Code refuses to pre-check a command with a variable in it when a rule asks.)
 */
export function withPermissionTail(wrapped: string, original: string): string {
  return `${wrapped}\nexit\n${original}`;
}

/**
 * Whether the command line starts with the `aquaman` or `aquaman-coder`
 * binary. Only the first word is looked at: a command that is not wrapped
 * runs without credentials and under the host's own permission rules, so
 * anything chained after it gains nothing by being here.
 */
export function isAquamanCommand(command: string): boolean {
  return /^\s*(?:aquaman|aquaman-coder)(?:\s|$)/.test(command);
}

/**
 * If the project map has env bindings AND this is a Bash tool call AND
 * the command isn't already wrapped, rewrite it to run under the
 * `aquaman-coder exec` wrapper. The wrapper resolves env via the broker
 * and pipes stdout/stderr through the redactor.
 */
export async function handlePreToolUse(
  event: HookEvent,
  ctx: HookContext = {}
): Promise<HookDecision | null> {
  if (event.tool_name !== 'Bash') return null;
  const cwd = event.cwd || process.cwd();

  const projects = loadProjects(ctx.projectsPath);
  const match = findProjectForCwd(cwd, projects);
  if (!match) return null;

  // No env bindings → nothing for the wrapper to inject; skip.
  if (Object.keys(match.config.env).length === 0) return null;

  const command = String((event.tool_input as any)?.command ?? '');
  if (!command) return null;

  // Avoid wrapping ourselves recursively.
  if (AQUAMAN_WRAPPER_MARKS.some((m) => command.includes(m))) return null;

  // Quick health check on the broker — if the proxy isn't running, deny
  // loudly so the user knows the credentials won't be available.
  const broker = ctx.broker ?? new BrokerClient();
  try {
    await broker.health();
  } catch (err) {
    // aquaman's own commands are how the proxy gets started, so a stopped
    // proxy never blocks them: they go to the host's normal permission
    // handling. While the proxy is up they are wrapped like any other
    // command, which keeps `aquaman get` output under value redaction.
    if (isAquamanCommand(command)) return null;
    const agent = ctx.host === 'codex' ? 'codex' : 'claude-code';
    // The client's own hint names the foreground command; the one below is the one an agent can use.
    const reason = (err as Error).message.replace(/\.?\s*Start it with: aquaman daemon\.?/, '');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `aquaman: proxy not reachable (${reason}), so this project's credentials ` +
          `cannot be injected. Start it with: aquaman init --agent ${agent}  ` +
          `(aquaman commands are not blocked; \`aquaman daemon\` runs in the foreground, use it in a terminal of your own)`,
      },
    };
  }

  // Wrapping comes with an `allow`, so it is only done when the project has a
  // credential to inject. A project whose bindings all point at nothing gets
  // no decision: the command runs as the host would have run it, prompts
  // included. Otherwise registering a project and binding a made-up reference
  // would be a way to switch permission prompts off.
  const refs = Object.values(match.config.env).map(parseRef).filter((r): r is NonNullable<typeof r> => r !== null);
  let anyAvailable = true;
  try {
    anyAvailable = (await broker.available(refs)).some(Boolean);
  } catch {
    // A proxy that cannot answer still gets the wrapper, which stops the
    // command itself when it has nothing to inject.
    anyAvailable = true;
  }
  if (!anyAvailable) {
    return ctx.host === 'codex' ? null : {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `aquaman: none of this project's credentials (${Object.keys(match.config.env).join(', ')}) ` +
          `are in the vault yet, so this command runs without them. ` +
          `Ask for one with: aquaman request aquaman://<service>/<key> --env <NAME>`,
      },
    };
  }

  const wrapper = ctx.wrapperPrefix ?? DEFAULT_WRAPPER;
  const wrapped = ctx.host === 'codex'
    ? `${wrapper} sh -c ${shellQuote(command)}`
    : withPermissionTail(`${wrapper} sh -c ${shellQuote(command)}`, command);

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...(event.tool_input as Record<string, unknown>),
        command: wrapped,
      },
      additionalContext:
        `aquaman: wrapped command under \`${wrapper}\` so credentials ` +
        `(${Object.keys(match.config.env).join(', ')}) are injected ` +
        `from the vault only for the duration of this command.`,
    },
  };
}

/**
 * Inspect tool output for leaked secrets and rewrite it via
 * `updatedToolOutput` (Claude Code ≥2.1.170) so redacted markers — not
 * the secrets — reach the transcript. Applies to every tool: Read/Grep
 * surfacing on-disk secrets, MCP tools, and Bash commands that didn't
 * route through the exec wrapper. String outputs stay strings; structured
 * outputs are deep-redacted with their shape preserved.
 *
 * With rewriting disabled (AQUAMAN_DISABLE_OUTPUT_REWRITE=1, for
 * pre-2.1.170 hosts) this degrades to the historical warning-only
 * additionalContext behavior.
 */
export function handlePostToolUse(
  event: HookEvent,
  ctx: HookContext = {}
): HookDecision | null {
  const out = (event as any).tool_response ?? (event as any).tool_output;
  if (out === undefined || out === null) return null;

  const rewriteEnabled = !(
    ctx.disableOutputRewrite ??
    process.env.AQUAMAN_DISABLE_OUTPUT_REWRITE === '1'
  );

  const { output, findings } =
    typeof out === 'string' ? redact(out) : redactDeep(out);
  if (findings.length === 0) return null;

  const summary = findings.map((f) => `${f.kind}×${f.count}`).join(', ');

  if (!rewriteEnabled) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `aquaman: tool output contained secret patterns (${summary}). ` +
          `These were detected after the fact — to scrub before output ` +
          `reaches the model, ensure agent-invoked commands route through ` +
          `\`aquaman-coder exec\`.`,
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: output,
      additionalContext:
        `aquaman: redacted secret patterns from this tool's output ` +
        `(${summary}) before it reached the transcript. The underlying ` +
        `data still exists at its source — treat it as sensitive.`,
    },
  };
}

/**
 * Stdio entry point: read JSON from stdin, dispatch by hook_event_name,
 * write decision to stdout (exit 0) or error to stderr (exit 2).
 */
export async function runHookFromStdin(
  _argv: string[],
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
    return 2;
  }

  let decision: HookDecision | null = null;
  try {
    const codex = ctx.host === 'codex';
    switch (event.hook_event_name) {
      case 'PreToolUse':
        decision = codex ? await handleCodexPreToolUse(event, ctx) : await handlePreToolUse(event, ctx);
        break;
      case 'PostToolUse':
        decision = codex ? handleCodexPostToolUse(event) : handlePostToolUse(event, ctx);
        break;
      default:
        return 0;
    }
  } catch (err) {
    process.stderr.write(`aquaman-coder: hook failed: ${(err as Error).message}\n`);
    return 2;
  }

  if (!decision) return 0;
  process.stdout.write(JSON.stringify(decision));
  return 0;
}

/**
 * POSIX single-quote-safe shell escape. Single quotes inside become
 * `'\''` per the standard idiom.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
