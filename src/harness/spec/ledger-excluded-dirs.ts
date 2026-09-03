// Bounded-walk constants for SpecLedger (line-cap split of ledger.ts).
// Pure data — see ledger.ts for how these bound the directory walk and the
// declared-fact-drift output.

export const EXCLUDED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"coverage",
	".interlinked",
	"vendor",
	"third_party",
	".next",
]);
export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_DEPTH = 8;
/** Caps on declared-fact-drift output — bound the O(sites²) string blowup
 *  (round-2 #3): at most this many sites quoted in a summary, and at most
 *  this many findings emitted per disagreeing fact name. */
export const FACT_SUMMARY_CAP = 8;
export const FACT_FINDING_CAP = 10;
