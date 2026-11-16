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
}

export const AGENT_PROMPT = `Set up aquaman in this project so you can request credentials instead of me pasting them.
Read https://github.com/tech4242/aquaman/blob/main/docs/agent-setup.md first and tell me
what it will change before you run anything.`;

export const HOSTS: Host[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    how: 'Claude asks for a key, you type it into a dialog, and each command that needs it gets it for as long as it runs. Output is redacted.',
    commands: `npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app && aquaman init --agent claude-code --no-hooks`,
    guide: 'claude-code',
    agentPrompt: true,
  },
  {
    id: 'codex',
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
    name: 'OpenClaw',
    how: 'The gateway holds a placeholder. Model calls go to a local proxy that adds the real key on the way out.',
    commands: `openclaw plugins install aquaman-plugin     # plugin + proxy
openclaw aquaman setup                      # pick your vault, store keys, wire OpenClaw
openclaw                                    # the proxy starts with the gateway`,
    guide: 'openclaw',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    how: 'Hermes is pointed at a local proxy and given a placeholder. The proxy adds the real provider key on the way out.',
    commands: `npm install -g aquaman-proxy
aquaman setup                              # pick your vault
aquaman credentials add anthropic api_key  # store a provider key
aquaman hermes setup                       # enable the local listener, write ~/.hermes/.env
aquaman daemon &                           # start the proxy
aquaman hermes doctor                      # verify`,
    guide: 'hermes',
  },
  {
    id: 'docker-sandboxes',
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
    name: 'The app your agent builds',
    how: 'The app is sent through a local proxy and holds a local token. The proxy adds the real key, and your request policies apply to what the app sends.',
    commands: `aquaman init --agent claude-code --no-hooks --loopback        # or: --agent codex
aquaman request aquaman://stripe/secret_key --env STRIPE_SECRET_KEY --via-proxy STRIPE_API_BASE
aquaman-coder exec -- npm start`,
    guide: 'app-through-proxy',
    note: 'The app has to read its API base URL from the environment.',
  },
];

/** The same picker as Markdown, for the page's `.md` version. */
export function hostsMarkdown(docLink: (slug: string) => string): string {
  const parts = ['## Start: pick your host', ''];
  for (const h of HOSTS) {
    parts.push(`### ${h.name}`, '', h.how, '', '```bash', h.commands, '```', '');
    if (h.agentPrompt) parts.push('Or hand it to your agent by pasting this:', '', '```text', AGENT_PROMPT, '```', '');
    if (h.note) parts.push(h.note, '');
    parts.push(`Guide: [${h.name}](${docLink(h.guide)})`, '');
  }
  return parts.join('\n');
}
