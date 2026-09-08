import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Integration lane — the `*.integration.test.ts` files: tests that spawn real
// subprocesses (git / tsc / biome / the CLI itself). These are (a) the slow
// tail of the suite and (b) the tests whose behavior can differ between the
// dev's macOS and CI's Linux — so they are exactly what a Linux CI run
// uniquely validates. They run as their own CI job so one slow lane can't
// blow the whole run's 25-minute timeout.
//
// `include` is overridden (not merged) to run ONLY the integration files;
// spreading the base `.test` then re-setting `include` avoids mergeConfig's
// array concat (which would otherwise re-add `src/**/*.test.ts` = everything).
export default defineConfig({
	...baseConfig,
	test: {
		...baseConfig.test,
		include: ["src/**/*.integration.test.ts"],
	},
});
