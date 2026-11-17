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

/** Remark plugin: a diagram marker in a guide's Markdown becomes the diagram. On GitHub the comment shows nothing. */
export function remarkDiagrams() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === 'html' && node.value.trim() === ROUTE_MARKER) node.value = routeDiagramHtml();
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}
