/**
 * Public packages cannot ship a maintainer's private account inventory.
 *
 * Keep this list empty in the public distribution. Each deployment must build
 * its own local, ignored read-only ledger before enabling any write allowlist.
 */
export const KNOWN_READ_ONLY_SOURCE_PROJECT_IDS = Object.freeze([] as const);
