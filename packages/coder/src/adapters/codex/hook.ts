/**
 * Codex hook handler (v0.16.0).
 *
 * Codex's hook protocol follows Claude Code's shape (verified against
 * openai/codex main, 2026-09-23; hooks are Stage::Stable, default on):
 *   - The shell tool (`exec_command`) reports `tool_name: "Bash"` and
 *     `tool_input: { command: "<string>" }`, so the Claude Code rewrite logic
 *     applies unchanged.
 *   - PreToolUse `updatedInput` requires `permissionDecision: "allow"`, and
 *     only `updatedInput.command` is read for shell calls. We send nothing
 *     else in the rewrite: invalid output makes Codex FAIL OPEN (the original
 *     command runs, unwrapped), so the payload stays minimal.
 *   - Deny: `permissionDecision: "deny"` plus a non-empty reason.
 *   - PostToolUse has no output-rewrite field for shell (`updatedMCPToolOutput`
 *     is rejected as unsupported). `continue: false` + `reason` does replace
 *     what the model sees, but also carries stop semantics we have not
 *     verified end to end, so PostToolUse here is warning-only. Wrapped
 *     commands are already scrubbed by `aquaman-coder exec`.
 */

import { redact, redactDeep } from 'aquaman-proxy';
import { handlePreToolUse, type HookContext, type HookDecision, type HookEvent } from '../claude-code/hook.js';

export async function handleCodexPreToolUse(
  event: HookEvent,
  ctx: HookContext = {}
): Promise<HookDecision | null> {
  const decision = await handlePreToolUse(event, ctx);
  const out = decision?.hookSpecificOutput;
  if (!out) return decision;

  if (out.permissionDecision === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: out.permissionDecisionReason,
      },
    };
  }

  const command = (out.updatedInput as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string') return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { command },
    },
  };
}

export function handleCodexPostToolUse(event: HookEvent): HookDecision | null {
  const out = event.tool_response;
  if (out === undefined || out === null) return null;

  const { findings } = typeof out === 'string' ? redact(out) : redactDeep(out);
  if (findings.length === 0) return null;

  const summary = findings.map((f) => `${f.kind}×${f.count}`).join(', ');
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `aquaman: this command's output contained secret patterns (${summary}). ` +
        `Codex offers no way for a hook to rewrite shell output, so they were not ` +
        `removed. Treat the output as sensitive and do not repeat those values.`,
    },
  };
}
