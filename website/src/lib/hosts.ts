/**
 * The ways to start, one per agent host. The home page shows them as a
 * picker, and the Markdown version of the page lists them in this order.
 */
export interface Host {
  id: string;
  name: string;
  /** How the credential reaches the thing that needs it. */
  how: string;
  commands: string;
  /** Docs slug of the full guide. */
  guide: string;
  note?: string;
  /** Whether "hand it to your agent" applies: only where an agent runs the setup. */
  agentPrompt?: boolean;
  /** The kind of host, which the picker groups by. */
  group: HostGroup;
}

export type HostGroup = 'coding' | 'personal' | 'sandbox' | 'own';

/** The picker's groups, in the order they are shown. */
export const HOST_GROUPS: { id: HostGroup; name: string }[] = [
  { id: 'coding', name: 'Coding assistants' },
  { id: 'personal', name: 'Personal agents' },
  { id: 'sandbox', name: 'Sandboxes' },
  { id: 'own', name: 'Your own app' },
];

export const AGENT_PROMPT = `Set up aquaman in this project so you can request credentials instead of me pasting them.
Read https://aquaman.sh/docs/agent-setup.md first and tell me
what it will change before you run anything.`;

export const HOSTS: Host[] = [
  {
    id: 'claude-code',
    group: 'coding',
    name: 'Claude Code',
    how: 'Claude asks for a key, you type it into a dialog, and each command that needs it gets it for as long as it runs. Output is redacted.',
    commands: `npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app && aquaman init --agent claude-code --no-hooks`,
    guide: 'claude-code',
    agentPrompt: true,
  },
  {
    id: 'codex',
    group: 'coding',
    name: 'Codex',
    how: 'Codex asks for a key, you type it into a dialog, and each command that needs it gets it for as long as it runs. Output is redacted.',
    commands: `npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app && aquaman init --agent codex --no-hooks`,
    guide: 'codex',
    note: "Codex's sandbox has to be allowed to reach the aquaman daemon; the guide has the setting.",
    agentPrompt: true,
  },
  {
    id: 'openclaw',
    group: 'personal',
    name: 'OpenClaw',
    how: 'The gateway holds a placeholder. Model calls go to a local proxy that adds the real key on the way out.',
    commands: `openclaw plugins install aquaman-plugin     # plugin + proxy
openclaw aquaman setup                      # pick your vault, store keys, wire OpenClaw
openclaw                                    # the proxy starts with the gateway`,
    guide: 'openclaw',
  },
  {
    id: 'hermes',
    group: 'personal',
    name: 'Hermes',
    how: 'Hermes is pointed at a local proxy and given a placeholder. The proxy adds the real provider key on the way out.',
    commands: `npm install -g aquaman-proxy
aquaman setup                              # pick your vault
aquaman credentials add anthropic api_key  # store a provider key
aquaman hermes setup                       # enable the local listener, point Hermes at it
aquaman daemon &                           # start the proxy
aquaman hermes doctor                      # verify`,
    guide: 'hermes',
  },
  {
    id: 'docker-sandboxes',
    group: 'sandbox',
    name: 'Docker Sandboxes',
    how: "Docker's own proxy injects the secret into the sandbox's traffic. aquaman supplies it from your vault, with an allow-list and a log entry per read.",
    commands: `npm install -g aquaman-proxy
aquaman setup                                        # pick your vault
aquaman daemon &                                     # start the daemon
aquaman credentials add github token                 # store the secret
aquaman broker allow aquaman://github/token          # allow it to be handed out
sbx secret set github \\
  --command "$(command -v node) $(command -v aquaman) get aquaman://github/token" \\
  --refresh on-demand`,
    guide: 'docker-sandboxes',
  },
  {
    id: 'openshell',
    group: 'sandbox',
    name: 'NVIDIA OpenShell',
    how: 'OpenShell injects the key outside the sandbox. aquaman is its credential driver, so the key comes from your vault by reference and OpenShell keeps no copy.',
    commands: `npm install -g aquaman-proxy @grpc/grpc-js @grpc/proto-loader
aquaman setup                                        # pick your vault
aquaman broker allow aquaman://anthropic/api_key     # allow the key to be handed to OpenShell
aquaman openshell setup                              # enable the driver, prints the gateway config
aquaman daemon &                                     # start or restart the daemon`,
    guide: 'openshell',
  },
  {
    id: 'your-app',
    group: 'own',
    name: 'Your app/agent',
    how: 'Any app or agent you run yourself, in any language, as long as it reads its API base URL from the environment. It is started with a local token and aquaman\'s address; aquaman adds the real key on the way out and applies your request policies.',
    commands: `npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app && aquaman init --agent claude-code --no-hooks --loopback
aquaman request aquaman://openai/api_key --env OPENAI_API_KEY --via-proxy OPENAI_BASE_URL
aquaman-coder exec -- npm start`,
    guide: 'app-through-proxy',
    note: 'No coding agent is needed for this. `--agent` only decides which instruction file gets a short note (CLAUDE.md or AGENTS.md); pick either.',
  },
];

/** The same picker as Markdown, for the page's `.md` version. */
export function hostsMarkdown(docLink: (slug: string) => string): string {
  const parts = ['## Start: pick your host', ''];
  // In the picker's groups, as on the HTML page.
  for (const group of HOST_GROUPS) {
    parts.push(`### ${group.name}`, '');
    for (const h of HOSTS.filter((host) => host.group === group.id)) {
      parts.push(`#### ${h.name}`, '', h.how, '', '```bash', h.commands, '```', '');
      if (h.agentPrompt) parts.push('Or hand it to your agent by pasting this:', '', '```text', AGENT_PROMPT, '```', '');
      if (h.note) parts.push(h.note, '');
      parts.push(`Guide: [${h.name}](${docLink(h.guide)})`, '');
    }
  }
  return parts.join('\n');
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Shell commands marked up the way the page's other code windows are: a
 * prompt before each command, references in the reference colour, comments
 * dimmed. A line that continues the one above (after a trailing backslash)
 * gets no prompt.
 */
export function shellHtml(commands: string): string {
  let continued = false;
  return commands
    .split('\n')
    .map((line) => {
      const hash = line.search(/(^|\s)#\s/);
      const code = hash === -1 ? line : line.slice(0, hash === 0 ? 0 : hash + 1);
      const comment = hash === -1 ? '' : line.slice(code.length);
      const prompt = !continued && code.trim() ? '<span class="prompt">&gt; </span>' : '';
      continued = /\\\s*$/.test(code);
      const body = escapeHtml(code).replace(/aquaman:\/\/[A-Za-z0-9._/-]+/g, '<span class="ref">$&</span>');
      return prompt + body + (comment ? `<span class="prompt">${escapeHtml(comment)}</span>` : '');
    })
    .join('\n');
}
