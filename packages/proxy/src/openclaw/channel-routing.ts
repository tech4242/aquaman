/**
 * Channel egress routing for the OpenClaw Gateway (v0.15.0+).
 *
 * The plugin's `globalThis.fetch` interceptor covered channel traffic until
 * OpenClaw moved each channel onto its own undici dispatcher. Verified on
 * 2026.7.33 and 2026.9.1: Telegram, Discord and Matrix build a dispatcher per
 * request and never consult the global fetch, so the interceptor sees nothing
 * and the channel token is used straight from openclaw.json.
 *
 * Routing therefore has to use whatever endpoint override the host exposes.
 * Telegram has one (`channels.telegram.apiRoot`, a documented reverse-proxy
 * and self-hosted Bot API knob), so it is pointed at the loopback listener.
 * No other bundled channel has an equivalent: Discord and Slack expose none,
 * and Matrix, Mattermost and Nextcloud Talk already point at the user's own
 * server rather than a vendor API. Those stay at-rest-only, and
 * `aquaman openclaw doctor` says so instead of implying coverage.
 *
 * The Bot API has no auth header: the token IS the `/bot<TOKEN>` path segment.
 * So the placeholder we write as `botToken` is the loopback token, and the
 * daemon accepts it from that segment (see findUrlPathCredentialSlot).
 */

/** Channels whose endpoint the host lets us override. */
export const CHANNEL_ROUTING_SUPPORTED = ['telegram'] as const;

/**
 * Channels aquaman can store credentials for but cannot route on OpenClaw,
 * because the host exposes no endpoint override for them. Used by doctor to
 * report the gap rather than let it look like coverage.
 */
export const CHANNEL_ROUTING_UNSUPPORTED = [
  'discord', 'slack', 'matrix', 'mattermost', 'line', 'twitch', 'telnyx',
  'zalo', 'twilio', 'bluebubbles', 'nextcloud-talk', 'msteams', 'feishu',
  'googlechat'
] as const;

/**
 * The URL OpenClaw should call for a channel, given the proxy's loopback
 * origin. Telegram's client appends `/bot<TOKEN>/<method>` and, for media,
 * `/file/bot<TOKEN>/<file_path>` — both land on our `/telegram` route.
 */
export function loopbackChannelBaseUrl(service: string, origin: string): string | null {
  // Trim trailing slashes without a regex: /\/+$/ backtracks polynomially on
  // an origin ending in many slashes (CodeQL js/polynomial-redos).
  let base = origin;
  while (base.length > 0 && base.endsWith('/')) base = base.slice(0, -1);
  if (service === 'telegram') return `${base}/telegram`;
  return null;
}

/** An apiRoot aquaman owns, as opposed to a self-hosted Bot API server. */
function isAquamanChannelBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/[a-z0-9-]+\/?$/.test(value);
}

/** Why a configured channel was left alone. */
export type ChannelSkipReason =
  | 'no-vault-credential'
  | 'user-endpoint'
  | 'token-file'
  | 'multi-account'
  | 'not-wired'
  | 'unroutable';

export interface ChannelSkip {
  channel: string;
  reason: ChannelSkipReason;
}

export interface ChannelRoutingResult {
  changed: boolean;
  /** Channels now routed through the proxy. */
  routedChannels: string[];
  /** Configured channels left as they were, with the reason. */
  skipped: ChannelSkip[];
}

export interface ChannelRoutingOptions {
  /** `http://127.0.0.1:<port>` — the loopback listener's origin. */
  loopbackOrigin: string;
  /** The loopback token, written as the channel's placeholder credential. */
  loopbackToken: string;
  /** Whether the vault holds the real credential for a service. */
  hasVaultCredential: (service: string) => boolean;
}

/**
 * Merge channel egress routing into a parsed openclaw.json object.
 * Mutates `config` in place (matching the CLI's existing merge style) and is
 * idempotent.
 *
 * Wiring a channel is all-or-nothing: a half-wired channel (our apiRoot, their
 * token, or ours with an empty vault) is a broken bot, so anything unexpected
 * means the channel is left exactly as it was and reported.
 */
export function wireChannelRouting(
  config: Record<string, any>,
  options: ChannelRoutingOptions
): ChannelRoutingResult {
  let changed = false;
  const routedChannels: string[] = [];
  const skipped: ChannelSkip[] = [];

  const channels = config.channels;
  if (!channels || typeof channels !== 'object') {
    return { changed, routedChannels, skipped };
  }

  for (const channel of CHANNEL_ROUTING_SUPPORTED) {
    const entry = channels[channel];
    // Not configured at all: nothing to route, and nothing worth reporting.
    if (!entry || typeof entry !== 'object') continue;

    // Multi-account channels map several bot tokens onto one service name,
    // which the vault's single `telegram/bot_token` cannot represent.
    const accounts = entry.accounts;
    if (accounts && typeof accounts === 'object' && Object.keys(accounts).length > 0) {
      skipped.push({ channel, reason: 'multi-account' });
      continue;
    }

    // tokenFile and TELEGRAM_BOT_TOKEN are separate sources whose precedence
    // over a config token we would be guessing at. Leave them alone.
    if (typeof entry.tokenFile === 'string' && entry.tokenFile) {
      skipped.push({ channel, reason: 'token-file' });
      continue;
    }

    const desiredBase = loopbackChannelBaseUrl(channel, options.loopbackOrigin);
    if (!desiredBase) {
      skipped.push({ channel, reason: 'unroutable' });
      continue;
    }

    // A self-hosted Bot API server or a regional reverse proxy. Routing
    // through us would send their traffic to Telegram instead.
    const currentBase = entry.apiRoot;
    if (currentBase !== undefined && !isAquamanChannelBaseUrl(currentBase)) {
      skipped.push({ channel, reason: 'user-endpoint' });
      continue;
    }

    // Without the real token in the vault the proxy has nothing to inject, and
    // overwriting their working token would take the bot down.
    if (!options.hasVaultCredential(channel)) {
      skipped.push({ channel, reason: 'no-vault-credential' });
      continue;
    }

    if (currentBase !== desiredBase) {
      entry.apiRoot = desiredBase;
      changed = true;
    }
    if (entry.botToken !== options.loopbackToken) {
      entry.botToken = options.loopbackToken;
      changed = true;
    }
    routedChannels.push(channel);
  }

  return { changed, routedChannels, skipped };
}

export interface ChannelRoutingStatus {
  /** Channels configured in openclaw.json that aquaman routes today. */
  routed: string[];
  /** Configured, routable, but not wired — with the reason. */
  notRouted: ChannelSkip[];
  /**
   * Configured channels the host exposes no endpoint override for. Their
   * credentials can live in the vault, but the token is used from
   * openclaw.json and the proxy never sees the traffic.
   */
  unroutable: string[];
}

/** Read-only status for `aquaman openclaw doctor`. */
export function channelRoutingStatus(
  config: Record<string, any>,
  options: Pick<ChannelRoutingOptions, 'hasVaultCredential'>
): ChannelRoutingStatus {
  const routed: string[] = [];
  const notRouted: ChannelSkip[] = [];
  const unroutable: string[] = [];

  const channels = config?.channels;
  if (!channels || typeof channels !== 'object') return { routed, notRouted, unroutable };

  for (const channel of CHANNEL_ROUTING_SUPPORTED) {
    const entry = channels[channel];
    if (!entry || typeof entry !== 'object') continue;
    if (isAquamanChannelBaseUrl(entry.apiRoot)) {
      routed.push(channel);
    } else if (entry.apiRoot !== undefined) {
      notRouted.push({ channel, reason: 'user-endpoint' });
    } else if (!options.hasVaultCredential(channel)) {
      notRouted.push({ channel, reason: 'no-vault-credential' });
    } else {
      notRouted.push({ channel, reason: 'not-wired' });
    }
  }

  for (const channel of CHANNEL_ROUTING_UNSUPPORTED) {
    const entry = channels[channel];
    if (entry && typeof entry === 'object') unroutable.push(channel);
  }

  return { routed, notRouted, unroutable };
}
