// ===========================================
// Decision Surface Map — categorization of competing tools / libraries
// ===========================================
// Each category lists named alternatives that occupy the same role. A repo
// with 1 entry per category has a narrow decision surface; a repo with N
// entries per category has N parallel choices an agent must navigate every
// edit. The detector in `decision-surface.ts` counts what's present.
//
// Descriptive only. The map does NOT declare any tool "correct" or any
// repo's choice "wrong". It reports what's there.
//
// Hand-curated, conservative: only widely-recognized names are listed.
// Adding a name is an explicit assertion that it competes with the other
// names in the same category. Adding alternatives that don't actually
// compete (e.g. a monorepo orchestrator alongside a bundler) breaks the
// "distinct choices" semantic the metric depends on.

/** Stable iteration order for output. */
export const DECISION_SURFACE_CATEGORIES = [
	"package_manager",
	"test_framework",
	"linter",
	"formatter",
	"bundler",
	"http_client",
	"date_lib",
] as const;

export type DecisionSurfaceCategory = (typeof DECISION_SURFACE_CATEGORIES)[number];

/** Build one value for every category in the report's canonical key set. */
export function decisionCategoryRecord<T>(create: (category: DecisionSurfaceCategory) => T): Record<DecisionSurfaceCategory, T> {
	// SAFETY: DecisionSurfaceCategory is derived from this exact tuple; each key receives one callback-produced value.
	return Object.fromEntries(DECISION_SURFACE_CATEGORIES.map((category) => [category, create(category)])) as Record<DecisionSurfaceCategory, T>;
}

interface ToolEntry {
	/** Canonical tool name used for dedup across signal sources
	 *  (package.json vs config file vs lockfile). */
	canonical: string;
	/** Categories this tool occupies. Most tools sit in one; a few
	 *  (biome, rome) span two. */
	categories: readonly DecisionSurfaceCategory[];
}

/** npm package name → tool entry. Lookup is exact match on the
 *  package.json key (no semver / range matching). */
export const PACKAGE_ENTRIES: Record<string, ToolEntry> = {
	// test_framework
	vitest: { canonical: "vitest", categories: ["test_framework"] },
	jest: { canonical: "jest", categories: ["test_framework"] },
	mocha: { canonical: "mocha", categories: ["test_framework"] },
	ava: { canonical: "ava", categories: ["test_framework"] },
	tap: { canonical: "tap", categories: ["test_framework"] },
	"@japa/runner": { canonical: "japa", categories: ["test_framework"] },
	jasmine: { canonical: "jasmine", categories: ["test_framework"] },
	qunit: { canonical: "qunit", categories: ["test_framework"] },

	// linter
	eslint: { canonical: "eslint", categories: ["linter"] },
	oxlint: { canonical: "oxlint", categories: ["linter"] },
	xo: { canonical: "xo", categories: ["linter"] },
	standard: { canonical: "standard", categories: ["linter"] },

	// formatter
	prettier: { canonical: "prettier", categories: ["formatter"] },
	dprint: { canonical: "dprint", categories: ["formatter"] },

	// linter + formatter (dual-role)
	"@biomejs/biome": { canonical: "biome", categories: ["linter", "formatter"] },
	rome: { canonical: "rome", categories: ["linter", "formatter"] },

	// bundler
	vite: { canonical: "vite", categories: ["bundler"] },
	webpack: { canonical: "webpack", categories: ["bundler"] },
	rollup: { canonical: "rollup", categories: ["bundler"] },
	esbuild: { canonical: "esbuild", categories: ["bundler"] },
	tsup: { canonical: "tsup", categories: ["bundler"] },
	parcel: { canonical: "parcel", categories: ["bundler"] },
	browserify: { canonical: "browserify", categories: ["bundler"] },
	snowpack: { canonical: "snowpack", categories: ["bundler"] },

	// http_client
	axios: { canonical: "axios", categories: ["http_client"] },
	got: { canonical: "got", categories: ["http_client"] },
	ky: { canonical: "ky", categories: ["http_client"] },
	"node-fetch": { canonical: "node-fetch", categories: ["http_client"] },
	undici: { canonical: "undici", categories: ["http_client"] },
	superagent: { canonical: "superagent", categories: ["http_client"] },
	"isomorphic-fetch": { canonical: "isomorphic-fetch", categories: ["http_client"] },
	"cross-fetch": { canonical: "cross-fetch", categories: ["http_client"] },
	request: { canonical: "request", categories: ["http_client"] },

	// date_lib
	moment: { canonical: "moment", categories: ["date_lib"] },
	dayjs: { canonical: "dayjs", categories: ["date_lib"] },
	"date-fns": { canonical: "date-fns", categories: ["date_lib"] },
	luxon: { canonical: "luxon", categories: ["date_lib"] },
	"@js-joda/core": { canonical: "js-joda", categories: ["date_lib"] },
};

/** Top-level config file basename → tool entry. Same canonical name as the
 *  corresponding package, so package.json and config-file signals dedup. */
export const CONFIG_FILE_ENTRIES: Record<string, ToolEntry> = {
	// vitest
	"vitest.config.ts": { canonical: "vitest", categories: ["test_framework"] },
	"vitest.config.js": { canonical: "vitest", categories: ["test_framework"] },
	"vitest.config.mjs": { canonical: "vitest", categories: ["test_framework"] },
	"vitest.config.mts": { canonical: "vitest", categories: ["test_framework"] },

	// jest
	"jest.config.ts": { canonical: "jest", categories: ["test_framework"] },
	"jest.config.js": { canonical: "jest", categories: ["test_framework"] },
	"jest.config.mjs": { canonical: "jest", categories: ["test_framework"] },
	"jest.config.cjs": { canonical: "jest", categories: ["test_framework"] },

	// mocha
	".mocharc.json": { canonical: "mocha", categories: ["test_framework"] },
	".mocharc.js": { canonical: "mocha", categories: ["test_framework"] },
	".mocharc.cjs": { canonical: "mocha", categories: ["test_framework"] },
	".mocharc.yml": { canonical: "mocha", categories: ["test_framework"] },
	".mocharc.yaml": { canonical: "mocha", categories: ["test_framework"] },

	// ava
	"ava.config.js": { canonical: "ava", categories: ["test_framework"] },
	"ava.config.cjs": { canonical: "ava", categories: ["test_framework"] },

	// eslint
	".eslintrc": { canonical: "eslint", categories: ["linter"] },
	".eslintrc.json": { canonical: "eslint", categories: ["linter"] },
	".eslintrc.js": { canonical: "eslint", categories: ["linter"] },
	".eslintrc.cjs": { canonical: "eslint", categories: ["linter"] },
	".eslintrc.yml": { canonical: "eslint", categories: ["linter"] },
	".eslintrc.yaml": { canonical: "eslint", categories: ["linter"] },
	"eslint.config.js": { canonical: "eslint", categories: ["linter"] },
	"eslint.config.mjs": { canonical: "eslint", categories: ["linter"] },
	"eslint.config.ts": { canonical: "eslint", categories: ["linter"] },

	// biome (dual)
	"biome.json": { canonical: "biome", categories: ["linter", "formatter"] },
	"biome.jsonc": { canonical: "biome", categories: ["linter", "formatter"] },

	// prettier
	".prettierrc": { canonical: "prettier", categories: ["formatter"] },
	".prettierrc.json": { canonical: "prettier", categories: ["formatter"] },
	".prettierrc.js": { canonical: "prettier", categories: ["formatter"] },
	".prettierrc.cjs": { canonical: "prettier", categories: ["formatter"] },
	".prettierrc.yaml": { canonical: "prettier", categories: ["formatter"] },
	".prettierrc.yml": { canonical: "prettier", categories: ["formatter"] },
	"prettier.config.js": { canonical: "prettier", categories: ["formatter"] },
	"prettier.config.cjs": { canonical: "prettier", categories: ["formatter"] },
	"prettier.config.mjs": { canonical: "prettier", categories: ["formatter"] },

	// dprint
	"dprint.json": { canonical: "dprint", categories: ["formatter"] },
	"dprint.jsonc": { canonical: "dprint", categories: ["formatter"] },

	// bundlers
	"vite.config.ts": { canonical: "vite", categories: ["bundler"] },
	"vite.config.js": { canonical: "vite", categories: ["bundler"] },
	"vite.config.mjs": { canonical: "vite", categories: ["bundler"] },
	"webpack.config.js": { canonical: "webpack", categories: ["bundler"] },
	"webpack.config.ts": { canonical: "webpack", categories: ["bundler"] },
	"webpack.config.cjs": { canonical: "webpack", categories: ["bundler"] },
	"rollup.config.js": { canonical: "rollup", categories: ["bundler"] },
	"rollup.config.mjs": { canonical: "rollup", categories: ["bundler"] },
	"rollup.config.ts": { canonical: "rollup", categories: ["bundler"] },
	"tsup.config.ts": { canonical: "tsup", categories: ["bundler"] },
	"tsup.config.js": { canonical: "tsup", categories: ["bundler"] },
	"esbuild.config.js": { canonical: "esbuild", categories: ["bundler"] },
	"parcel.config.js": { canonical: "parcel", categories: ["bundler"] },
};

/** Top-level lockfile basename → package-manager canonical name. Lockfile
 *  presence is the authoritative signal for which package manager is in
 *  use; package.json's `packageManager` field is a hint but not required. */
export const LOCKFILE_TO_PACKAGE_MANAGER: Record<string, string> = {
	"package-lock.json": "npm",
	"yarn.lock": "yarn",
	"pnpm-lock.yaml": "pnpm",
	"bun.lockb": "bun",
	"bun.lock": "bun",
};
