// ===========================================
// tseslint-types — dedicated flat config
// ===========================================
// Consumed ONLY by the `tseslint-types` verify tool row
// (src/commands/verify/verify-tools.ts), invoked as:
//   npx eslint --config eslint.interlinked-types.config.mjs --format unix src
//
// This is a TYPE-CHECKER-POWERED INERT-CODE SCANNER, not a style linter:
// every rule below needs type information and flags constructs the type
// system proves redundant or unreachable — the class no syntactic detector
// in the registry can see. biome/oxlint own the style lane.
//
// LOAD-BEARING: every rule is "error", never "warn". eslint exits 0 when only
// warnings fired, and the verify runner treats exit 0 as "no findings".
//
// The filename is deliberately NOT eslint.config.*: eslint's automatic config
// lookup never finds it, so adding this file does not switch on the generic
// `eslint` verify tool or change any editor integration.

import tseslint from "typescript-eslint";

export default tseslint.config({
	files: ["src/**/*.ts", "src/**/*.tsx"],
	ignores: [
		// Tests assert on fixtures and mocks; no-unnecessary-condition is noisy
		// there (deliberate always-true guards around test data).
		"src/**/*.test.ts",
		"src/**/*.test.tsx",
		"src/**/__tests__/**",
		"src/**/__fixtures__/**",
		"src/**/*.mutation-kill*.ts",
		"src/**/*.d.ts",
	],
	// This config enables a different rule set from the generic eslint config,
	// so a directive that is "unused" HERE may be load-bearing there.
	linterOptions: { reportUnusedDisableDirectives: "off" },
	languageOptions: {
		parser: tseslint.parser,
		parserOptions: {
			// projectService resolves each file's nearest tsconfig — no separate
			// eslint tsconfig to keep in sync with the build one.
			projectService: true,
			tsconfigRootDir: import.meta.dirname,
		},
	},
	plugins: { "@typescript-eslint": tseslint.plugin },
	rules: {
		// `x as T` where x is already T — an inert cast that hides future drift.
		"@typescript-eslint/no-unnecessary-type-assertion": "error",
		// `string | "a"`, `T | never`, `unknown | T` — union members the checker
		// proves subsumed.
		"@typescript-eslint/no-redundant-type-constituents": "error",
		// The dead-branch rule: a condition the types prove always-true or
		// always-false (`if (x)` where x is non-nullable, an impossible
		// discriminant case, a `?.` on a non-nullable). This is unreachable
		// runtime code found through type evidence.
		"@typescript-eslint/no-unnecessary-condition": "error",
		// A generic parameter used once (or never) is not a generic.
		"@typescript-eslint/no-unnecessary-type-parameters": "error",
		"@typescript-eslint/no-duplicate-type-constituents": "error",
		"@typescript-eslint/no-useless-empty-export": "error",
	},
});
