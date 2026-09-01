// Supply-chain / runtime safety checks.
// Extracted from generic-checks.ts.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import type { InlineMatch } from "./shared.js";

/**
 * Read the side-loaded popular-packages JSON. The file lives next to this
 * module both in source (`src/harness/checks/data/`) and in the built
 * bundle (copied by `scripts/copy-runtime-assets.mjs`). Returns the parsed
 * `name` list; empty on any error so the in-source allowlist below remains
 * the load-bearing fallback.
 *
 * Why side-loaded vs imported: the file is refreshable by a script
 * (`scripts/refresh-npm-popular.mjs`) without rebuilding the bundle.
 * Adding a name becomes a JSON-only PR.
 */
function loadPopularPackagesData(): readonly string[] {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const candidates = [
			resolve(here, "data", "npm-popular-packages.json"),
			// Bundled layout: dist collapses checks/* into a single file, but
			// copy-runtime-assets places the JSON at dist/checks/data/...
			resolve(here, "checks", "data", "npm-popular-packages.json"),
		];
		for (const p of candidates) {
			if (!existsSync(p)) continue;
			// Side-loaded JSON off disk: an entry in `packages` can legally be
			// `null` (hand-edited or partially-written data file), so the type
			// says so and the reader guards it rather than trusting the shape.
			const json = JSON.parse(readFileSync(p, "utf-8")) as {
				packages?: Array<{ name?: unknown } | null>;
			};
			if (!Array.isArray(json.packages)) return [];
			return json.packages
				.map((entry) => (typeof entry?.name === "string" ? entry.name : null))
				.filter((n): n is string => !!n);
		}
		return [];
	} catch {
		return [];
	}
}

const POPULAR_PACKAGES_DATA = loadPopularPackagesData();

// ===========================================
// Supply Chain / Runtime Safety Checks
// ===========================================

/**
 * Detect typosquatted package names in package.json.
 * Compares dependencies against a list of popular npm packages
 * using Levenshtein distance ≤2 to catch near-miss names.
 * e.g., "expresss", "lodashe", "reacr", "axois"
 */
const POPULAR_PACKAGES = new Set([
	"express",
	"react",
	"react-dom",
	"next",
	"vue",
	"angular",
	"lodash",
	"axios",
	"moment",
	"dayjs",
	"chalk",
	"commander",
	"inquirer",
	"yargs",
	"typescript",
	"webpack",
	"vite",
	"esbuild",
	"rollup",
	"parcel",
	"jest",
	"mocha",
	"vitest",
	"cypress",
	"playwright",
	"eslint",
	"prettier",
	"biome",
	"mongoose",
	"sequelize",
	"prisma",
	"knex",
	"typeorm",
	"dotenv",
	"cors",
	"helmet",
	"morgan",
	"body-parser",
	"cookie-parser",
	"jsonwebtoken",
	"bcrypt",
	"bcryptjs",
	"passport",
	"uuid",
	"socket.io",
	"ws",
	"graphql",
	"apollo-server",
	"aws-sdk",
	"firebase",
	"stripe",
	"underscore",
	"ramda",
	"rxjs",
	"zod",
	"joi",
	"yup",
	"debug",
	"winston",
	"pino",
	"bunyan",
	"cheerio",
	"puppeteer",
	"jsdom",
	"crypto-js",
	"node-fetch",
	"got",
	"superagent",
	"ky",
	"fs-extra",
	"glob",
	"minimatch",
	"chokidar",
	"sharp",
	"canvas",
	"jimp",
	"nodemailer",
	"twilio",
	"sendgrid",
	"redis",
	"ioredis",
	"pg",
	"mysql2",
	"sqlite3",
	"better-sqlite3",
	"electron",
	"tauri",
	"tailwindcss",
	"postcss",
	"autoprefixer",
	"sass",
	"less",
	"styled-components",
	"emotion",
	"formik",
	"react-hook-form",
	"react-query",
	"swr",
	"zustand",
	"redux",
	"framer-motion",
	"three",
	"d3",
	"openai",
	"langchain",
	"anthropic",
]);

/**
 * Allowlist of well-known legitimate npm packages whose short names collide
 * with `POPULAR_PACKAGES` at Levenshtein distance ≤2. These are popular dev
 * tools (TypeScript runners, build wrappers, CLI utilities, etc.) whose
 * names are only 3–4 characters and therefore trip the typosquat heuristic
 * on every `package.json` edit despite being legitimate.
 *
 * Rule of thumb for adding here: must be in wide use (100k+ weekly downloads
 * or part of an established toolchain), published by a known maintainer, and
 * confirmed by the team. This list is additive — it never relaxes typosquat
 * detection for anything outside it.
 *
 * Namespaced orgs (`@types/`, `@typescript-eslint/`, etc.) are handled
 * separately via `isAllowlistedScope()` below.
 */
const KNOWN_LEGITIMATE_PACKAGES = new Set([
	// TypeScript toolchain
	"tsup", // ESM bundler by Anthony Fu (~1M weekly)
	"tsx", // TypeScript execute by egoist (~3M weekly)
	"tsc", // TypeScript compiler binary alias
	"tslib", // Official TypeScript runtime helpers
	"tsd", // TypeScript definition tester
	"tsdown", // Rolldown-based TS bundler
	"tsimp", // Modern ts-node alternative
	"ts-node", // Traditional TS runner
	"ts-jest", // Jest TS transformer
	"ts-morph", // TS compiler API wrapper
	"ts-pattern", // Exhaustive pattern matching
	"ts-toolbelt", // Type-level utilities
	"tsc-alias", // Path alias resolution
	"tsconfig-paths", // Path alias resolution at runtime
	"tsconfck", // tsconfig lookup
	"tsutils", // TS AST utilities
	"type-fest", // Curated type utilities
	// Build + bundling
	"turbo", // Turborepo
	"nx", // Nx monorepo
	"lerna", // Monorepo manager
	"unbuild", // unjs bundler
	"microbundle", // preact-team bundler
	"magic-string", // Source map-aware string editing
	"unplugin", // Framework-agnostic plugin API
	// CLI + process helpers
	"execa", // Better child_process
	"zx", // Google shell scripting
	"shelljs", // Unix shell commands
	"cross-env", // Cross-platform env vars
	"npm-run-all", // Run npm scripts in parallel
	"concurrently", // Same as above
	"rimraf", // Cross-platform rm -rf
	"nodemon", // Dev file watcher
	"husky", // Git hooks
	"lint-staged", // Run linters on staged files
	// Parsing / data
	"yaml", // YAML parser (eemeli)
	"toml", // TOML parser
	"ini", // INI parser (isaacs)
	"semver", // Semantic versioning
	"minimist", // Arg parser
	"mri", // Smaller arg parser (lukeed)
	"cac", // CLI arg framework
	"meow", // CLI helper (sindresorhus)
	"citty", // unjs CLI builder
	// Async + flow control
	"p-limit", // Concurrency limit
	"p-queue", // Promise queue
	"p-map", // Concurrent map
	"p-retry", // Retry a promise
	"p-timeout", // Timeout a promise
	// HTTP (less-popular but legit)
	"undici", // Node.js native HTTP/2 client
	"cross-fetch", // Isomorphic fetch polyfill
	"ofetch", // unjs fetch wrapper
	"h3", // unjs HTTP server
	"hono", // Ultrafast edge web framework
	"koa", // Web framework (distinct from express)
	"fastify", // Fast web framework
	"polka", // Micro web framework
	"itty-router", // Edge router
	// IDs / tiny utils
	"nanoid", // Tiny ID generator
	"ulid", // Lexicographically sortable IDs
	"cuid", // Collision-resistant IDs
	"mime", // MIME type lookup
	"mitt", // Tiny event emitter
	"defu", // Object default merger
	"deepmerge", // Deep object merge
	// Glob + fs
	"fast-glob", // Fast glob
	"micromatch", // Pattern matching
	"picomatch", // Pattern matching (smaller)
	"anymatch", // Glob matcher
	"normalize-path", // Path normalization
	"find-up", // Walk up looking for file
	"pkg-dir", // Find package.json dir
	"env-paths", // OS-standard paths
	// Runtimes / package managers
	"bun", // Runtime (oven-sh)
	"bun-types", // Bun type declarations
	"deno", // Runtime
	"pnpm", // Package manager
	"yarn", // Package manager
	"wrangler", // Cloudflare Workers CLI
	"miniflare", // Workers test runner
	// Terminal + output
	"ora", // Terminal spinner
	"boxen", // Terminal boxes
	"chalk-template", // chalk template literal variant
	"colorette", // Color alternative
	"picocolors", // Smallest color lib
	"kolorist", // Another small color lib
	"ansi-colors", // Color alternative
	"strip-ansi", // Strip ANSI codes
	"supports-color", // Feature detection
	// Git / vcs
	"simple-git", // git wrapper
	"isomorphic-git", // Pure JS git
	// Python test/coverage tooling (PyPI). These trip the npm-centric heuristic
	// at distance ≤2 against npm names (e.g. pytest vs vitest) despite being
	// canonical, hugely-popular Python packages. The supply-chain guard's
	// HARNESS_REQUIRED_DEV_TOOLING carve-out also relies on these passing
	// findTyposquatMatch.
	"pytest", // canonical Python test runner (vs npm "vitest", dist 2)
]);

// Merge in the side-loaded data file. The file is the refreshable surface;
// the in-source list above is the always-available fallback. Both feed into
// the same allowlist used by isAllowlistedDep().
for (const name of POPULAR_PACKAGES_DATA) {
	KNOWN_LEGITIMATE_PACKAGES.add(name);
}

/**
 * Regex-based allowlist for scoped orgs whose package names are inherently
 * short (and therefore prone to Levenshtein collisions). `@types/foo`,
 * `@typescript-eslint/parser`, `@vitejs/plugin-react`, etc. are legitimate
 * by construction — the scope itself attests to origin.
 */
const ALLOWLISTED_SCOPES = [
	/^@types\//,
	/^@typescript-eslint\//,
	/^@typescript\//,
	/^@vitejs\//,
	/^@vitest\//,
	/^@rollup\//,
	/^@esbuild\//,
	/^@swc\//,
	/^@babel\//,
	/^@eslint\//,
	/^@biomejs\//,
	/^@jest\//,
	/^@playwright\//,
	/^@cypress\//,
	/^@testing-library\//,
	/^@nestjs\//,
	/^@next\//,
	/^@vue\//,
	/^@angular\//,
	/^@nuxt\//,
	/^@remix-run\//,
	/^@sveltejs\//,
	/^@astrojs\//,
	/^@tanstack\//,
	/^@emotion\//,
	/^@mui\//,
	/^@tailwindcss\//,
	/^@prisma\//,
	/^@cloudflare\//,
	/^@aws-sdk\//,
	/^@azure\//,
	/^@google-cloud\//,
	/^@sentry\//,
	/^@datadog\//,
	/^@opentelemetry\//,
	/^@anthropic-ai\//,
	/^@openai\//,
	/^@modelcontextprotocol\//,
	/^@unocss\//,
	/^@unjs\//,
	/^@sindresorhus\//,
	/^@inquirer\//,
	/^@commander-js\//,
	/^@clack\//,
	/^@napi-rs\//,
	/^@rspack\//,
	/^@rsbuild\//,
	/^@parcel\//,
];

/** Returns true if `dep` is known-legitimate by name or scope. */
function isAllowlistedDep(dep: string): boolean {
	if (KNOWN_LEGITIMATE_PACKAGES.has(dep)) return true;
	for (const re of ALLOWLISTED_SCOPES) {
		if (re.test(dep)) return true;
	}
	return false;
}

function levenshtein(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	if (Math.abs(a.length - b.length) > 2) return 3; // fast exit
	const matrix: number[][] = [];
	for (let i = 0; i <= a.length; i++) matrix[i] = [i];
	for (let j = 0; j <= b.length; j++) nonNull(matrix[0])[j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			nonNull(matrix[i])[j] = Math.min(
				nonNull(nonNull(matrix[i - 1])[j]) + 1,
				nonNull(nonNull(matrix[i])[j - 1]) + 1,
				nonNull(nonNull(matrix[i - 1])[j - 1]) + cost,
			);
		}
	}
	return nonNull(nonNull(matrix[a.length])[b.length]);
}

/**
 * Public single-name typosquat check. Returns the popular package + distance
 * when `name` looks like a near-miss, or null when it's clean. Used by the
 * allowlist CLI to refuse approving a typosquat name into the allowlist.
 */
export function findTyposquatMatch(
	name: string,
): { popular: string; distance: number } | null {
	if (!name || name.length < 3) return null;
	if (POPULAR_PACKAGES.has(name)) return null;
	if (isAllowlistedDep(name)) return null;
	for (const popular of POPULAR_PACKAGES) {
		const dist = levenshtein(name.toLowerCase(), popular.toLowerCase());
		if (dist > 0 && dist <= 2) return { popular, distance: dist };
	}
	return null;
}

export function checkTyposquatDependencies(pkgJsonPath: string): InlineMatch[] {
	if (!existsSync(pkgJsonPath)) return [];
	let content: string;
	let pkg: JsonObject;
	try {
		content = readFileSync(pkgJsonPath, "utf-8");
		pkg = JSON.parse(content);
	} catch {
		return [];
	}

	const allDeps: Record<string, string> = {
		...((pkg.dependencies as Record<string, string> | undefined) || {}),
		...((pkg.devDependencies as Record<string, string> | undefined) || {}),
	};

	const depNames = Object.keys(allDeps);
	if (depNames.length === 0) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (const dep of depNames) {
		if (matches.length >= 5) break;
		// Skip if it IS one of the popular packages (exact match)
		if (POPULAR_PACKAGES.has(dep)) continue;
		// Skip if it's in the well-known-legitimate allowlist — these are
		// confirmed-safe dev tools whose short names trip the heuristic
		// (e.g. tsup vs yup, tsx vs ws). The allowlist is additive and never
		// relaxes detection for anything outside it.
		if (isAllowlistedDep(dep)) continue;

		// Check Levenshtein distance to each popular package
		for (const popular of POPULAR_PACKAGES) {
			if (dep === popular) break;
			const dist = levenshtein(dep.toLowerCase(), popular.toLowerCase());
			if (dist > 0 && dist <= 2 && dep.length >= 3) {
				const lineIdx = lines.findIndex((l) => l.includes(`"${dep}"`));
				matches.push({
					line: lineIdx >= 0 ? lineIdx + 1 : 1,
					text: `Possible typosquat: "${dep}" is ${dist} character${dist > 1 ? "s" : ""} away from popular package "${popular}". Verify this is the intended package.`,
				});
				break;
			}
		}
	}
	return matches;
}

// NOTE: Future improvement — "didn't change dependencies" short-circuit.
// Detecting that a package.json edit only bumped the `version` field (or any
// non-deps field) would avoid re-running typosquat scoring entirely. That
// requires threading pre-edit content into this check the way
// `checkPackageJsonPublishInvariants` does (reads from disk at PreToolUse
// time when it still holds old content). At PostToolUse the on-disk copy is
// the new one, so the check would need either an extra `preContent` parameter
// or to receive the Edit tool's `old_string`/`new_string`. Deferred for now:
// the allowlist already kills the observed false positives, and a separate
// re-architecture would touch evaluator/post-tool.ts + the check-registry
// signature. Track as a harness-level deps-diff short-circuit.

// Self-contained runtime-safety detectors live in a sibling file to keep
// this module under the per-file line cap. Re-exported here so existing
// importers of "./supply-chain.js" (the generic-checks barrel + tests)
// keep working unchanged.
export {
	checkErrorMessageLeakage,
	checkHardcodedLocalhost,
	checkImportFromDist,
	checkInfiniteRetryLoop,
	checkPlaceholderValues,
	checkProcessExitInLibrary,
} from "./supply-chain-detectors.js";
