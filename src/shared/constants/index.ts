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
