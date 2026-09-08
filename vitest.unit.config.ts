import { configDefaults, defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Unit lane — everything EXCEPT the integration lane (`*.integration.test.ts`,
// the subprocess-spawning / Linux-sensitive suite). These are the fast,
// OS-independent tests: regex, parsing, data transforms, pure check logic.
//
// CI runs this as its own job on every push for quick feedback and as the
// clean-checkout backstop; it sits well under the job timeout. The full suite
// (unit + integration) still runs via `npm test` (pre-push + local).
//
// Inherits every base setting (timeouts, retry, env, CI worker cap, coverage);
// only `exclude` is extended. The base default export is a plain config object,
// so spreading its `.test` and overriding one key avoids mergeConfig's
// array-concatenation (which would otherwise keep the integration files in).
export default defineConfig({
	...baseConfig,
	test: {
		...baseConfig.test,
		exclude: [
			...configDefaults.exclude,
			"**/*.integration.test.ts",
			// recurrence.test.ts was quarantined here 2026-07 as an unexplained
			// "collection hang on the ubuntu runner". ROOT CAUSE FOUND 2026-07-29:
			// its unwritable-cwd tests probed "/proc/nonexistent/x", and recursive
			// mkdir under /proc SPINS FOREVER on the Linux runner (the mechanism
			// guard-state.test.ts documented in 2026-06 — the knowledge just never
			// propagated). Three sibling files carried the same probe and hung the
			// lane one-at-a-time in queue order (runs 30410747800 / 30412876710 /
			// 30466905490) — which mimicked a positional hang until the shards
			// isolated two guilty files at once. All probes are now file-as-parent
			// (ENOTDIR on every platform) and the file is back in the lane because
			// the CAUSE is fixed, not because it was innocent.
		],
	},
});
