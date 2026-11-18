/**
 * Strict parsing of the request target a client sends to the proxy.
 *
 * Everything the proxy decides (which service, whether policy allows it) and
 * everything it forwards (the upstream path) comes from ONE reading of the
 * client's URL, made here. Two readings of the same text can disagree, and
 * each disagreement is a bypass:
 *
 *   - `/anthropic/\evil.example/x`: WHATWG URL treats `\` as `/`, so resolved
 *     against an upstream this is `//evil.example/x`, a scheme-relative URL
 *     naming another host. The injected credential would follow it there.
 *   - `/v1/x/../organizations` and `/v1/%2e%2e/...`: a segment matcher sees
 *     `x`, `..`; a URL resolver produces `/v1/organizations`.
 *   - `/v1/organizations?x=1`: a query left on the last segment makes a rule
 *     on `/v1/organizations` miss.
 *
 * So anything ambiguous is refused, not normalised silently, and the module
 * returns every way an upstream server might interpret the path so policy can
 * require all of them to be allowed.
 */

export type RequestTarget =
  | {
      ok: true;
      /** Canonical path segments, as forwarded upstream. Never `.`/`..`, never containing `/` or `\`. */
      segments: string[];
      /** `?query` exactly as sent, or `''`. Forwarded unchanged, never part of policy matching. */
      search: string;
    }
  | { ok: false; reason: string };

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** Normalise one segment's percent-encoding (RFC 3986 6.2.2): decode unreserved characters, upper-case the rest. */
function canonicalSegment(segment: string): string {
  return segment.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

/** Characters that must never reach the path, raw: backslash, whitespace, control characters, fragment marker. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_RAW = /[\\#\u0000- \u007f]/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_DECODED = /[\\\u0000-\u001f\u007f]/;

export function parseRequestTarget(rawUrl: string): RequestTarget {
  // Origin-form only (`/path?query`). Absolute-form and authority-form targets
  // name a host of the client's choosing.
  if (!rawUrl.startsWith('/')) return { ok: false, reason: 'request target must start with /' };

  const q = rawUrl.indexOf('?');
  const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const search = q === -1 ? '' : rawUrl.slice(q);

  if (FORBIDDEN_RAW.test(rawPath)) {
    return { ok: false, reason: 'path contains a backslash, whitespace, control character or fragment' };
  }
  // The query is forwarded verbatim; it only has to be unable to end the request line.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f#]/.test(search)) {
    return { ok: false, reason: 'query contains whitespace, a control character or a fragment' };
  }

  const segments: string[] = [];
  for (const raw of rawPath.split('/')) {
    if (raw === '') continue; // leading, trailing and doubled slashes
    if (/%(?![0-9A-Fa-f]{2})/.test(raw)) return { ok: false, reason: 'path contains a malformed percent-escape' };

    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { ok: false, reason: 'path contains a percent-escape that is not valid UTF-8' };
    }
    if (decoded === '.' || decoded === '..') return { ok: false, reason: 'path contains a dot segment' };
    if (FORBIDDEN_DECODED.test(decoded)) {
      return { ok: false, reason: 'path contains an encoded backslash or control character' };
    }
    // An encoded slash can make one segment two on the upstream. If either
    // half would then be a dot segment, the path means something else there.
    if (decoded.split('/').some((part) => part === '.' || part === '..')) {
      return { ok: false, reason: 'path contains an encoded dot segment' };
    }
    // Double encoding of the characters above (`%252e%252e`, `%252f`, `%255c`):
    // harmless on a correct upstream, a traversal on one that decodes twice.
    if (/%(2e|2f|5c)/i.test(decoded)) return { ok: false, reason: 'path contains a double-encoded separator' };

    segments.push(canonicalSegment(raw));
  }
  return { ok: true, segments, search };
}

/**
 * Every path an upstream server might take these segments to mean, for policy
 * evaluation. The first is the path as forwarded. The others cover servers
 * that decode `%2F` into a separator or drop `;parameters` from a segment
 * (both common), so a deny rule cannot be dodged by spelling a segment in a
 * way only the upstream understands. A request is allowed only if policy
 * allows all of them.
 */
export function policyPathInterpretations(segments: string[]): string[] {
  const asForwarded = '/' + segments.join('/');
  const lenient: string[] = [];
  for (const segment of segments) {
    for (const part of decodeURIComponent(segment).split('/')) {
      const withoutParams = part.split(';')[0];
      if (withoutParams !== '') lenient.push(withoutParams);
    }
  }
  const asLenientUpstream = '/' + lenient.join('/');
  return asLenientUpstream === asForwarded ? [asForwarded] : [asForwarded, asLenientUpstream];
}

/** Headers some upstreams honour as the real method of a POST. */
const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-method-override', 'x-http-method'];

/**
 * Query parameters some frameworks honour as the real method (`?_method=DELETE`:
 * Rails, Laravel, Express method-override).
 */
const METHOD_OVERRIDE_PARAMS = ['_method'];

/** `?query` as name/value pairs, percent-decoded where that is possible. */
function queryPairs(search: string): Array<[string, string]> {
  const decode = (text: string): string => {
    try {
      return decodeURIComponent(text.replace(/\+/g, ' '));
    } catch {
      return text;
    }
  };
  const pairs: Array<[string, string]> = [];
  for (const part of search.replace(/^\?/, '').split(/[&;]/)) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    pairs.push(eq === -1 ? [decode(part), ''] : [decode(part.slice(0, eq)), decode(part.slice(eq + 1))]);
  }
  return pairs;
}

/**
 * The methods policy must allow for this request: the one on the request line,
 * plus any a method-override header or `_method` query parameter names. `POST`
 * with `X-HTTP-Method-Override: DELETE` is a DELETE on upstreams that honour
 * the header, so a `deny DELETE` rule has to see it.
 *
 * A header sent twice reaches us joined with a comma, and a client can write
 * the list itself (`DELETE, GET`). Which entry an upstream takes is its own
 * business, so every entry counts as a method the request may be.
 */
export function policyMethods(
  method: string,
  headers: Record<string, string | string[] | undefined>,
  search = '',
): string[] {
  const methods = [method.toUpperCase()];
  const add = (text: string) => {
    for (const token of text.split(/[\s,;]+/)) {
      const m = token.toUpperCase();
      if (m && !methods.includes(m)) methods.push(m);
    }
  };
  for (const name of METHOD_OVERRIDE_HEADERS) {
    const value = headers[name];
    for (const v of Array.isArray(value) ? value : value ? [value] : []) add(v);
  }
  for (const [name, value] of queryPairs(search)) {
    if (METHOD_OVERRIDE_PARAMS.includes(name.toLowerCase())) add(value);
  }
  return methods;
}

/** Headers some upstreams and the proxies in front of them honour as the real path of the request. */
const PATH_OVERRIDE_HEADERS = ['x-original-url', 'x-rewrite-url'];

/**
 * Paths named by a path-override header, for policy evaluation alongside the
 * path on the request line. `GET /v1/models` with `X-Original-URL: /v1/admin`
 * is a request for `/v1/admin` on an upstream that honours the header, so a
 * deny rule on that path has to see it.
 *
 * Each value is read by the same strict parser as the request line. One that
 * the parser refuses is reported as `ok: false`: the proxy cannot say what an
 * upstream would make of it, so the request is not forwarded.
 */
export function policyPathOverrides(
  headers: Record<string, string | string[] | undefined>,
): { ok: true; paths: string[] } | { ok: false; reason: string } {
  const paths: string[] = [];
  for (const name of PATH_OVERRIDE_HEADERS) {
    const value = headers[name];
    for (const joined of Array.isArray(value) ? value : value ? [value] : []) {
      for (const raw of joined.split(',')) {
        let text = raw.trim();
        if (text === '') continue;
        // Some senders give a full URL; only its path matters to a rule.
        const absolute = /^https?:\/\/[^/?#]*(.*)$/i.exec(text);
        if (absolute) text = absolute[1] || '/';
        const target = parseRequestTarget(text);
        if (!target.ok) return { ok: false, reason: `${name} header: ${target.reason}` };
        for (const p of policyPathInterpretations(target.segments)) {
          if (!paths.includes(p)) paths.push(p);
        }
      }
    }
  }
  return { ok: true, paths };
}
