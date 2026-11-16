/**
 * What `aquaman init --agent` leaves behind so that later agent sessions keep
 * using aquaman without being told: a short block in the project's
 * instructions file, and a skill in the agent's personal skills directory.
 *
 * Locations (verified against the hosts' own docs and source):
 *   - Claude Code: `CLAUDE.md` in the project; skills in
 *     `~/.claude/skills/<name>/SKILL.md`.
 *   - Codex 0.169: `AGENTS.md` in the project; skills in
 *     `~/.agents/skills/<name>/SKILL.md`, frontmatter `name` (64 characters at
 *     most) and `description` both required.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CodingAgent = 'claude-code' | 'codex';

export const SKILL_NAME = 'aquaman-credentials';
const BLOCK_START = '<!-- aquaman:start -->';
const BLOCK_END = '<!-- aquaman:end -->';

export const AGENTS_BLOCK = `${BLOCK_START}
## Credentials (aquaman)

This project gets API keys, tokens and other secrets from aquaman. Do not put secret values in \`.env\` files, source files, commands or chat.

- When a task needs a credential, run \`aquaman request aquaman://<service>/<key> --env <ENV_NAME> --json\`. A person supplies it in a dialog. You get a status and the reference, never the value.
- Shell commands run in this project already have its variables injected. In command output a value shows as \`[REDACTED:...]\`; that is expected and means it is set.
- What is configured: \`aquaman coder status --json\`. Something not working: \`aquaman coder doctor --json\`.
${BLOCK_END}
`;

export const SKILL_MD = `---
name: ${SKILL_NAME}
description: Use when a task needs an API key, access token, password or other secret, when you are about to create or edit a .env file, or when a command fails because a credential is missing. Gets the credential from the user's own vault through aquaman so the value never appears in the conversation, in files or in command output.
---

# Credentials through aquaman

aquaman keeps secrets in the user's vault (Keychain, 1Password, Bitwarden, HashiCorp Vault and others) and injects them into commands when they run. You work with references such as \`aquaman://github/token\`. You never see, type or store a secret value.

## When a task needs a credential

1. Pick a reference: \`aquaman://<service>/<key>\`, lowercase service, for example \`aquaman://github/token\`, \`aquaman://stripe/secret_key\`, \`aquaman://openai/api_key\`.
2. Ask for it, naming the environment variable the code reads:

   \`\`\`bash
   aquaman request aquaman://github/token --env GITHUB_TOKEN --json
   \`\`\`

   Run it from the project directory. A dialog opens on the user's machine and the command waits for it, up to 90 seconds (\`--timeout <seconds>\` changes that). Tell the user to look for the dialog before you run the command. They type the value there, or approve one that is already stored.
3. Read \`status\` in the JSON:
   - \`ready\` (exit 0): the credential was already in the vault and usable. No dialog was shown and nobody was asked; do not tell the user they entered anything. The variable is now set for every shell command you run in this project. Continue with the task.
   - \`stored\`, \`approved\` (exit 0): the user typed the value, or allowed one that was already stored. The variable is now set. Continue with the task.
   - \`declined\` (exit 2): the user said no. Do not ask again; ask them how they want to proceed.
   - \`pending\` (exit 3): nobody answered, or nobody could be asked. If the user is there, run the same command once more. Otherwise show them the \`fix\` command from the output and wait.
   - \`error\` (exit 4): aquaman is not running. Run the setup below, then retry. aquaman's own commands always run, even when other commands in this project are being refused because the proxy is down.
   - \`error\` (exit 1): the command was wrong. Read \`error\` and \`fix\`; with \`--env\` it usually means this directory is not a set-up project yet.

## Setup, once per project

\`\`\`bash
aquaman init --agent claude-code --json    # or: --agent codex
\`\`\`

It never prompts and can be run again safely. If \`aquaman\` is not installed: \`npm install -g aquaman-proxy aquaman-coder\`. The output lists \`human_steps\` when the user has to do something, such as restarting the session; pass those on.

## Rules

- Never ask the user to paste a secret into the chat, and never write one into a file, a command line or a commit. Use \`aquaman request\`.
- Do not create \`.env\` files holding secrets. If one exists, leave it alone and tell the user they can move a value into the vault themselves with \`aquaman credentials add <service> <key>\`.
- A value printed as \`[REDACTED:...]\` is set and working. Do not try to print, decode or work around the redaction.
- To check what is available: \`aquaman coder status --json\`. To diagnose: \`aquaman coder doctor --json\`.
`;

export interface AgentsFileResult {
  path: string;
  /** `created` a new file, `added` the block to an existing one, `updated` an older block, or `unchanged`. */
  action: 'created' | 'added' | 'updated' | 'unchanged';
}

/**
 * These files are written without anyone watching, so the target has to be an
 * ordinary file where it says it is. A link would send the write somewhere
 * else, possibly outside the project.
 */
function assertPlainFileOrAbsent(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return;
  }
  if (!st.isFile()) throw new Error(`${file} is not a regular file (a link or a directory); not writing to it`);
}

export function agentsFileName(agent: CodingAgent): string {
  return agent === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
}

/**
 * Put the aquaman block into the project's instructions file. Text outside
 * the markers is never touched, and a second run changes nothing.
 */
export function writeAgentsBlock(agent: CodingAgent, projectDir: string): AgentsFileResult {
  const file = path.join(projectDir, agentsFileName(agent));
  assertPlainFileOrAbsent(file);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, AGENTS_BLOCK, { flag: 'wx' });
    return { path: file, action: 'created' };
  }
  const current = fs.readFileSync(file, 'utf-8');
  const start = current.indexOf(BLOCK_START);
  const end = current.indexOf(BLOCK_END);
  let next: string;
  let action: AgentsFileResult['action'];
  if (start !== -1 && end > start) {
    const tail = current.slice(end + BLOCK_END.length).replace(/^\n/, '');
    next = current.slice(0, start) + AGENTS_BLOCK + tail;
    action = 'updated';
  } else {
    next = current + (current.endsWith('\n') ? '\n' : '\n\n') + AGENTS_BLOCK;
    action = 'added';
  }
  if (next === current) return { path: file, action: 'unchanged' };
  fs.writeFileSync(file, next);
  return { path: file, action };
}

export function skillPath(agent: CodingAgent, home: string = os.homedir()): string {
  const root = agent === 'claude-code' ? path.join(home, '.claude', 'skills') : path.join(home, '.agents', 'skills');
  return path.join(root, SKILL_NAME, 'SKILL.md');
}

export function installSkill(agent: CodingAgent, home: string = os.homedir()): { path: string; changed: boolean } {
  const file = skillPath(agent, home);
  assertPlainFileOrAbsent(file);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === SKILL_MD) return { path: file, changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SKILL_MD);
  return { path: file, changed: true };
}
