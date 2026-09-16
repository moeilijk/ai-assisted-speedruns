// The versions `aas check` reads and the ones this tooling writes. No imports, so a store can take this module as it is,
// in a server or in a browser.

/** The summary.json schemas the checker reads. */
export const SUMMARY_SCHEMAS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
/** The bundle packagings the checker reads (`bundle.bundle_version`). */
export const BUNDLE_VERSIONS = [1];
/** Tooling releases after which a run may not simply go on with the new release (CHANGELOG.md, BREAKING). */
export const BREAKING_RELEASES = [];
/** The shape of summary.json this tooling writes. */
export const SUMMARY_SCHEMA = SUMMARY_SCHEMAS.at(-1);
/** The bundle's packaging this tooling writes: which files it holds and how they are named. */
export const BUNDLE_VERSION = BUNDLE_VERSIONS.at(-1);
