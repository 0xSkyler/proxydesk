export * from './countries';

export const APP_NAME = 'ProxyDesk';
export const APP_ID = 'com.proxydesk.desktop';

/** Partition name prefix for each browser workspace's isolated session. */
export const PARTITION_PREFIX = 'persist:browser-';
/** Partition prefix used when "Persist browser sessions" is OFF (in-memory, per-run isolation). */
export const EPHEMERAL_PARTITION_PREFIX = 'browser-ephemeral-';

export const MIN_PROXY_TIMEOUT_MS = 1000;
export const MAX_PROXY_TIMEOUT_MS = 60000;
export const DEFAULT_PROXY_TIMEOUT_MS = 8000;

/** Upper bound on how many browser workspaces can be configured at once.
 * Each one is a genuinely separate Chromium renderer process + isolated
 * session, so this is a real RAM/CPU ceiling, not an arbitrary UI limit —
 * chosen generously above the old fixed 10 so "sometimes I need more than
 * 10" is possible, without letting the count field accept something that
 * would just crash the machine. */
export const MAX_BROWSER_COUNT = 100;
