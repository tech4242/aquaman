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

/**
 * How a command in the project gets its credentials: `hook` when the host's
 * hook wraps every shell command, `exec` when nothing is installed in the host
 * and the agent prefixes the commands that need them.
 */
export type RunMode = 'hook' | 'exec';

const RUN_LINE: Record<RunMode, string> = {
  hook: 'Shell commands run in this project already have its variables injected.',
  exec: 'Run a command that needs these credentials as \`aquaman-coder exec -- <command>\`; it sets the project\'s variables for that command only. Other commands run as usual, without them.',
};

export const agentsBlock = (mode: RunMode): string => `${BLOCK_START}
## Credentials (aquaman)

This project gets API keys, tokens and other secrets from aquaman. Do not put secret values in \`.env\` files, source files, commands or chat.

- When a task needs a credential, run \`aquaman request aquaman://<service>/<key> --env <ENV_NAME> --json\`. A person supplies it in a dialog. You get a status and the reference, never the value.
- ${RUN_LINE[mode]} In command output a value shows as \`[REDACTED:...]\`; that is expected and means it is set.
- What is configured: \`aquaman coder status --json\`. Something not working: \`aquaman coder doctor --json\`.
${BLOCK_END}
`;

/** The block for a project whose commands the hook wraps. */
export const AGENTS_BLOCK = agentsBlock('hook');

export const SKILL_MD = `---
name: ${SKILL_NAME}
description: Use when a task needs an API key, access token, password or other secret, when you are about to create or edit a .env file, or when a command fails because a credential is missing. Gets the credential from the user's own vault through aquaman so the value never appears in the conversation, in files or in command output.
---

# Credentials through aquaman

aquaman keeps secrets in the user's vault (Keychain, 1Password, Bitwarden, HashiCorp Vault and others) and injects them into commands when they run. You work with references such as \`aquaman://github/token\`. You have no need to see, type or store a secret value.

## When a task needs a credential

1. Pick a reference: \`aquaman://<service>/<key>\`, lowercase service, for example \`aquaman://github/token\`, \`aquaman://stripe/secret_key\`, \`aquaman://openai/api_key\`.
2. Ask for it, naming the environment variable the code reads:

   \`\`\`bash
   aquaman request aquaman://github/token --env GITHUB_TOKEN --json
   \`\`\`

   Run it from the project directory. A dialog opens on the user's machine and the command waits for it, up to 90 seconds (\`--timeout <seconds>\` changes that). Tell the user to look for the dialog before you run the command. They type the value there, or approve one that is already stored.
3. Read \`status\` in the JSON:
   - \`ready\` (exit 0): the credential was already in the vault and usable. No dialog was shown and nobody was asked; do not tell the user they entered anything. The variable is now bound for this project (see "Running commands"). Continue with the task.
   - \`stored\`, \`approved\` (exit 0): the user typed the value, or allowed one that was already stored. The variable is now bound for this project. Continue with the task.
   - \`declined\` (exit 2): the user said no. Do not ask again; ask them how they want to proceed.
   - \`pending\` (exit 3): nobody answered, or nobody could be asked. If the user is there, run the same command once more. Otherwise show them the \`fix\` command from the output and wait.
   - \`error\` (exit 4): aquaman is not running. Run the setup below, then retry. aquaman's own commands always run, even when other commands in this project are being refused because the proxy is down.
   - \`error\` (exit 1): the command was wrong. Read \`error\` and \`fix\`; with \`--env\` it usually means this directory is not a set-up project yet.

## Running commands

How a command gets the project's variables depends on how the project was set up. \`aquaman init\` reports it as \`mode\`, and the project's instructions file says the same.

- \`exec\`: nothing is installed in the agent host. Run a command that needs a credential as \`aquaman-coder exec -- <command>\`, for example \`aquaman-coder exec -- npm test\`. Commands you run without it do not have the variables. The prefix is not a way around the user's permission rules: if a command would be refused or need approval without it, ask instead of adding it.
- \`hook\`: a hook wraps every shell command in the project, so you run commands as usual. The hook only loads when a session starts: in the session that installed it, use \`aquaman-coder exec -- <command>\` until the user has restarted.

If you do not know which applies, \`aquaman-coder exec -- <command>\` works in both.

## Setup, once per project

\`\`\`bash
aquaman init --agent claude-code --no-hooks --json    # or: --agent codex
\`\`\`

If the project is not set up yet, ask the user before you run this, and say what it does. With \`--no-hooks\` this registers the project, starts the aquaman daemon, installs this skill and adds a short block to the project's instructions file. It changes no setting of the agent host and no permission prompt, so it is the form to use unless the user has asked for more.

Without \`--no-hooks\` it also installs a user-level hook that wraps every shell command in registered projects, so commands need no prefix. That hook answers the permission prompt for the commands it wraps. Ask the user before choosing it.

Either form never prompts and can be run again safely. If \`aquaman\` is not installed: \`npm install -g aquaman-proxy aquaman-coder\`. The output lists \`human_steps\` when the user has to do something; pass those on.

## Keeping the key out of the app as well

By default the command you run holds the real value while it runs. If the app's client library accepts a base URL, ask for the credential this way instead:

\`\`\`bash
aquaman request aquaman://stripe/secret_key --env STRIPE_SECRET_KEY --via-proxy STRIPE_API_BASE --json
\`\`\`

The app then gets a local token in \`STRIPE_SECRET_KEY\` and aquaman's proxy URL in \`STRIPE_API_BASE\`; write it to use that variable as its API base URL when set. The proxy adds the real key and applies the user's request policies; the token only forwards requests and cannot be used to read a value. It needs \`aquaman init --agent <agent> --loopback\` once, which opens a token-gated listener on 127.0.0.1: tell the user. If the command answers with an error and a \`fix\`, follow the fix or drop \`--via-proxy\`.

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
export function writeAgentsBlock(agent: CodingAgent, projectDir: string, mode: RunMode = 'hook'): AgentsFileResult {
  const block = agentsBlock(mode);
  const file = path.join(projectDir, agentsFileName(agent));
  assertPlainFileOrAbsent(file);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, block, { flag: 'wx' });
    return { path: file, action: 'created' };
  }
  const current = fs.readFileSync(file, 'utf-8');
  const start = current.indexOf(BLOCK_START);
  const end = current.indexOf(BLOCK_END);
  let next: string;
  let action: AgentsFileResult['action'];
  if (start !== -1 && end > start) {
    const tail = current.slice(end + BLOCK_END.length).replace(/^\n/, '');
    next = current.slice(0, start) + block + tail;
    action = 'updated';
  } else {
    next = current + (current.endsWith('\n') ? '\n' : '\n\n') + block;
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
