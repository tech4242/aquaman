/**
 * The reference diagram: where aquaman sits between an app and an API when
 * the app is routed through it. One source for the home page and for the
 * guide, which places it with a `<!-- diagram: route -->` comment in its
 * Markdown (see remarkDiagrams). Plain HTML and CSS (styles: `.dia` in
 * global.css), so the text is real text and it stacks on a narrow screen.
 */
export const ROUTE_MARKER = '<!-- diagram: route -->';

/** @param {{ art?: boolean }} [options] `art` adds the octopus and the chest, for the home page. */
export function routeDiagramHtml({ art = false } = {}) {
  const sprite = (name, cls) => (art ? `<img class="dia-art ${cls}" src="/sprites/${name}.svg" alt="" aria-hidden="true" decoding="async">` : '');
  return `<div class="dia">
<div class="dia-box"><h3>Your app or agent</h3><p>Reads its key and base URL from the environment, as always.</p><code>OPENAI_API_KEY=<b>aqm_rt_…</b><br>OPENAI_BASE_URL=<i>http://127.0.0.1:8585/openai/v1</i></code></div>
<div class="dia-arrow"><span>request + local token</span><small>never leaves your machine</small></div>
<div class="dia-box dia-me">${sprite('octopus', 'dia-octopus')}<h3>aquaman</h3><p>Checks your request policy, swaps the token for the real key, logs the use.</p></div>
<div class="dia-arrow"><span>request + real key</span><small>over HTTPS</small></div>
<div class="dia-box"><h3>The API</h3><p>OpenAI, GitHub, Stripe, or any HTTP API that takes a key in a header.</p></div>
<div class="dia-up"><span>reads the key when a request needs it</span></div>
<div class="dia-box dia-vault">${sprite('chest', 'dia-chest')}<h3>Your vault</h3><p>Keychain, 1Password, Bitwarden, Vault… The key stays here.</p></div>
</div>
<p class="dia-note"><b>Your app never holds the key.</b> It holds a token that only works on this machine and only forwards requests through aquaman.</p>`;
}

export const OVERVIEW_MARKER = '<!-- diagram: overview -->';

/** One way a key leaves the daemon: its name, what happens, who uses it, and who then holds the key. */
const HANDOFFS = [
  {
    name: 'Forward and inject',
    what: 'aquaman adds the key to the request and checks your method and path rules.',
    users: [['OpenClaw: model keys and Telegram', 'aquaman-plugin'], ['Hermes: model keys', 'aquaman hermes setup'], ['Your own app or SDK', 'aquaman-coder bind --via-proxy']],
    holds: 'The agent or app never holds the key.',
  },
  {
    name: 'Resolve',
    what: 'One command, or a host at startup, gets the key in its environment.',
    users: [['Claude Code and Codex', 'aquaman-coder'], ['Hermes project secrets', 'aquaman-hermes']],
    holds: 'That one process holds the key.',
  },
  {
    name: 'Hand to the host',
    what: 'The host asks aquaman for the key and injects it at its own egress.',
    users: [['NVIDIA OpenShell', 'aquaman openshell setup'], ['Docker Sandboxes', 'aquaman get']],
    holds: 'The sandbox never holds the key.',
  },
];

/**
 * The overview diagram: your vault, the daemon and the three ways a key
 * leaves it. The same picture as docs/assets/how-it-fits.svg, which GitHub
 * shows in the README; here it is HTML, so the text is real text and the
 * columns stack on a narrow screen. A guide places it with
 * `<!-- diagram: overview -->`. It is not on the home page, which tells the
 * same in its own sections.
 */
export function overviewDiagramHtml() {
  const parts = [['Vault backends, links', 'eight stores, existing items'], ['Approval dialog', 'a person decides'], ['Declared scope', 'only named references'], ['Audit log', 'hash-chained, every use']];
  return `<div class="dia-over">
<div class="dia-box dia-over-vault"><h3>Your vault</h3><p>1Password, Bitwarden, HashiCorp Vault, Keeper, Keychain, KeePassXC, systemd-creds, or an encrypted file if you have none. aquaman runs no vault service.</p></div>
<div class="dia-down"><span>reads your keys from it</span></div>
<div class="dia-box dia-me"><h3><code>aquaman-proxy</code> the daemon on your machine</h3><ul class="dia-parts">${parts.map(([a, b]) => `<li><b>${a}</b><span>${b}</span></li>`).join('')}</ul></div>
<div class="dia-down"><span>hands a key off in one of three ways</span></div>
<div class="dia-ways">${HANDOFFS.map((h) => `<div class="dia-box dia-way"><h3>${h.name}</h3><p>${h.what}</p><dl>${h.users.map(([who, how]) => `<dt>${who}</dt><dd><code>${how}</code></dd>`).join('')}</dl><p class="dia-holds">${h.holds}</p></div>`).join('')}</div>
</div>`;
}

/** Remark plugin: a diagram marker in a guide's Markdown becomes the diagram. On GitHub the comment shows nothing. */
export function remarkDiagrams() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === 'html' && node.value.trim() === ROUTE_MARKER) node.value = routeDiagramHtml();
      if (node.type === 'html' && node.value.trim() === OVERVIEW_MARKER) node.value = overviewDiagramHtml();
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}
