/** SpacetimeDB connection settings (local server only — never maincloud). */
export const SPACETIMEDB_URI = 'ws://127.0.0.1:3000';
export const DB_NAME = 'transit-demo';

/** sessionStorage key prefix: per database AND per tab → each tab gets its own identity. */
export const STORAGE_PREFIX = `transville:${SPACETIMEDB_URI}:${DB_NAME}`;
export const TOKEN_KEY = `${STORAGE_PREFIX}:token`;
export const RETRIED_KEY = `${STORAGE_PREFIX}:retried`;

/** Demo supervisor access code (stored server-side in the private DemoSetting table). */
export const DEMO_SUPERVISOR_CODE = 'PCC2026';

/** Fribourg map defaults. */
export const MAP_CENTER: [number, number] = [46.803, 7.152];
export const MAP_ZOOM = 14;
