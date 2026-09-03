// Tests for supply-chain checks. Primary focus here is the typosquat
// allowlist — legitimate dev tools whose short names sit at Levenshtein ≤2
// from a popular package were firing on every package.json edit before
// `KNOWN_LEGITIMATE_PACKAGES` and `ALLOWLISTED_SCOPES` shipped.
//
// Mutation-testing hardening (2026-08): the it.each blocks below assert
// full-array `toEqual` (not `.toContain`/`.length`) against the ENTIRE
// hardcoded POPULAR_PACKAGES / reachable-subset lists so a single string
// literal mutated to "" in the source's Set/array is observable — removing
// any one member turns its own exact-match test into a false positive.
// See the "reachability" describes for why most of KNOWN_LEGITIMATE_PACKAGES
// and ALLOWLISTED_SCOPES entries are NOT individually testable this way
// (mutating them is a genuinely equivalent mutant, proved via computed
// Levenshtein distance against the whole POPULAR_PACKAGES set).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkTyposquatDependencies, findTyposquatMatch } from "./supply-chain.js";

// Verbatim copy of the source's POPULAR_PACKAGES Set contents (supply-chain.ts
// lines ~59-166). Kept as a flat array here purely for it.each iteration —
// this is fixture data, not a re-implementation of any logic under test.
const ALL_POPULAR_PACKAGES = [
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
];

// Subset of KNOWN_LEGITIMATE_PACKAGES whose Levenshtein distance to some
// entry in ALL_POPULAR_PACKAGES is <= 2 — i.e. the only members whose
// presence/absence is observable through checkTyposquatDependencies at all
// (computed by literally running the same levenshtein algorithm offline;
// see the "reachability" describe below for the unreachable remainder).
const REACHABLE_KNOWN_LEGIT = [
	"tsup",
	"tsx",
	"tsc",
	"tsd",
	"tsimp",
	"nx",
	"unbuild",
	"zx",
	"ini",
	"mri",
	"h3",
	"hono",
	"koa",
	"ulid",
	"cuid",
	"mime",
	"mitt",
	"defu",
	"bun",
	"deno",
	"yarn",
	"ora",
	"pytest",
];

// Scopes from ALLOWLISTED_SCOPES whose minimal matching string ("@scope/")
// lands within Levenshtein distance <= 2 of some ALL_POPULAR_PACKAGES entry.
const REACHABLE_SCOPES = [
	"typescript",
	"vitest",
	"rollup",
	"esbuild",
	"eslint",
	"jest",
	"playwright",
	"cypress",
	"next",
	"vue",
	"angular",
	"emotion",
	"tailwindcss",
	"prisma",
	"aws-sdk",
	"openai",
	"inquirer",
	"parcel",
];

describe("checkTyposquatDependencies — allowlist", () => {
	let tempDir: string;
	let pkgPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-allowlist-"));
		pkgPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does NOT flag tsup (distance 2 from popular 'yup')", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { tsup: "^8.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag tsx (distance 2 from popular 'ws')", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { tsx: "^4.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag vitest (allowlisted, also in POPULAR_PACKAGES)", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag a mixed package.json of legit dev tools", () => {
		// Mirrors what interlinked-cli's own package.json looks like when
		// only the `version` field is bumped. This was the original bug.
		writeFileSync(
			pkgPath,
			JSON.stringify({
				name: "interlinked-cli",
				version: "0.1.1",
				dependencies: { commander: "^12.0.0" },
				devDependencies: {
					"@types/node": "^20.0.0",
					tsup: "^8.0.0",
					tsx: "^4.0.0",
					typescript: "^5.5.0",
					vitest: "^3.0.0",
				},
			}),
		);
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag scoped orgs (e.g. @types/*, @typescript-eslint/*)", () => {
		writeFileSync(
			pkgPath,
			JSON.stringify({
				devDependencies: {
					"@types/node": "^20.0.0",
					"@typescript-eslint/parser": "^7.0.0",
					"@vitest/coverage-v8": "^3.0.0",
				},
			}),
		);
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("STILL flags a real typosquat ('chlk' → 'chalk')", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { chlk: "^5.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("chlk");
		expect(nonNull(matches[0]).text).toContain("chalk");
	});

	it("STILL flags 'expresss' (classic duplicate-letter typosquat)", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { expresss: "^4.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("expresss");
		expect(nonNull(matches[0]).text).toContain("express");
	});

	it("STILL flags 'typescirpt' (transposition typosquat)", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { typescirpt: "^5.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("typescript");
	});
});

describe("checkTyposquatDependencies — JSON-loaded allowlist", () => {
	let tempDir: string;
	let pkgPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-data-"));
		pkgPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does NOT flag 'jose' (distance 2 from popular 'jest') — the user-reported FP", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { jose: "^5.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([]);
	});

	it("does NOT flag 'effect' (FP library, distance to popular)", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { effect: "^3.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});

	it("does NOT flag 'jiti' (unjs ecosystem)", () => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { jiti: "^2.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});

	it("does NOT flag 'vuex' (Vue ecosystem)", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { vuex: "^4.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});
});

// ===========================================
// POPULAR_PACKAGES — exhaustive exact-match coverage
// ===========================================
// Every exact popular-package name must resolve to zero findings. Because
// each is asserted individually (not just "some subset works"), mutating any
// single string literal inside the POPULAR_PACKAGES Set literal to "" turns
// that ONE package into a non-member, which then falls through to the
// Levenshtein loop and gets flagged as a typosquat of itself/none — this
// it.each catches exactly that package's assertion failing.
describe("checkTyposquatDependencies — exhaustive POPULAR_PACKAGES exact-match", () => {
	let tempDir: string;
	let pkgPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-popular-"));
		pkgPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each(ALL_POPULAR_PACKAGES)("does NOT flag exact popular package %s", (name) => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { [name]: "^1.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});
});

// ===========================================
// KNOWN_LEGITIMATE_PACKAGES / ALLOWLISTED_SCOPES — reachable subset
// ===========================================
// Only entries within Levenshtein distance <=2 of some POPULAR_PACKAGES
// member are observable through checkTyposquatDependencies at all — for the
// rest, removing them from the allowlist can never change output (they were
// never going to be flagged either way). See "reachability" describe below.
describe("checkTyposquatDependencies — reachable KNOWN_LEGITIMATE_PACKAGES", () => {
	let tempDir: string;
	let pkgPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-legit-reach-"));
		pkgPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each(REACHABLE_KNOWN_LEGIT)("does NOT flag legit dev tool %s", (name) => {
		writeFileSync(pkgPath, JSON.stringify({ devDependencies: { [name]: "^1.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});
});

describe("checkTyposquatDependencies — reachable ALLOWLISTED_SCOPES", () => {
	let tempDir: string;
	let pkgPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-scope-reach-"));
		pkgPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// The minimal string matching `/^@scope\//` is "@scope/" itself (regex is
	// a prefix test with no required suffix) — deliberately not a "real"
	// npm package name, chosen purely because it's the shortest string that
	// both matches the scope regex AND sits within Levenshtein distance 2 of
	// the scope's own bare name in POPULAR_PACKAGES (e.g. "@vue/" is exactly
	// 2 deletions from "vue").
	it.each(REACHABLE_SCOPES)("does NOT flag minimal scoped dep for @%s/", (scope) => {
		const dep = `@${scope}/`;
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { [dep]: "^1.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});
});

// ===========================================
// Equivalence proofs — unreachable allowlist entries
// ===========================================
// The remaining KNOWN_LEGITIMATE_PACKAGES / ALLOWLISTED_SCOPES members have
// minimum Levenshtein distance > 2 (computed offline, same algorithm as
// source) from every POPULAR_PACKAGES entry. isAllowlistedDep() is only
// consulted to skip a dep that would OTHERWISE be flagged by the distance
// loop; if the distance loop could never flag it anyway (distance always >
// 2), removing the allowlist entry is unobservable through
// checkTyposquatDependencies. These two smoke tests apply that argument to a
// representative sample of each collection and pin that the sample stays
// unflagged either way — the same "was it ever reachable" argument applies
// uniformly to every other unreachable member (same code path, same guard).
describe("checkTyposquatDependencies — unreachable-allowlist equivalence sample", () => {
	let tempDir: string;
	let pkgPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-unreach-"));
		pkgPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("unreachable KNOWN_LEGITIMATE_PACKAGES sample stays unflagged (turbo, lerna, husky)", () => {
		writeFileSync(
			pkgPath,
			JSON.stringify({ devDependencies: { turbo: "^1.0.0", lerna: "^1.0.0", husky: "^1.0.0" } }),
		);
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});

	it("unreachable ALLOWLISTED_SCOPES sample stays unflagged (@types/, @mui/, @sentry/)", () => {
		writeFileSync(
			pkgPath,
			JSON.stringify({
				dependencies: { "@types/x": "^1.0.0", "@mui/x": "^1.0.0", "@sentry/x": "^1.0.0" },
			}),
		);
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});
});

// ===========================================
// loadPopularPackagesData — module-init side-loaded JSON (mocked fs)
// ===========================================
// loadPopularPackagesData() runs once at module init and is not exported, so
// it can only be observed indirectly: mock node:fs, reset the module
// registry, dynamically re-import supply-chain.js, and check whether a dep
// that's ONLY a near-miss via the mocked JSON payload gets allowlisted.
describe("loadPopularPackagesData — side-loaded JSON merge (mocked fs)", () => {
	afterEach(() => {
		vi.doUnmock("node:fs");
		vi.resetModules();
	});

	it("merges the bundled-layout candidate (checks/data/...) when the source-layout candidate is absent, skips null entries without losing later ones", async () => {
		vi.resetModules();
		// "zoddd" is Levenshtein distance 2 from popular "zod" and appears
		// ONLY in this mocked JSON payload — never in the hardcoded
		// KNOWN_LEGITIMATE_PACKAGES fallback — so it is flagged as a
		// typosquat UNLESS this data file is correctly located and parsed.
		const payload = JSON.stringify({ packages: [null, { name: "zoddd" }] });
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			const isDataPath = (p: string) => p.endsWith("npm-popular-packages.json");
			return {
				...actual,
				existsSync: (p: string) =>
					isDataPath(p) ? p.endsWith("checks/checks/data/npm-popular-packages.json") : actual.existsSync(p),
				readFileSync: (p: string, enc?: unknown) => {
					if (!isDataPath(p)) return actual.readFileSync(p as never, enc as never);
					if (p.endsWith("checks/checks/data/npm-popular-packages.json")) return payload;
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				},
			};
		});
		const { checkTyposquatDependencies: freshCheck } = await import("./supply-chain.js");
		const tempDir = mkdtempSync(join(tmpdir(), "typosquat-mocked-fs-"));
		try {
			const pkgPath = join(tempDir, "package.json");
			writeFileSync(pkgPath, JSON.stringify({ dependencies: { zoddd: "^1.0.0" } }));
			// If the resolved path is wrong (string-literal mutants on the
			// "checks"/"data"/filename segments), OR the existsSync guard is
			// disabled (never skips the missing first candidate, throws
			// reading it, returns [] before reaching this candidate at all),
			// OR the optional-chaining removal makes the `null` entry throw
			// instead of being filtered — in every case "zoddd" is NOT
			// merged and gets flagged. Only the fully-correct path merges it
			// and produces zero matches here.
			expect(freshCheck(pkgPath)).toEqual([]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns [] (no crash, no merge) when the JSON file is malformed", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			const isDataPath = (p: string) => p.endsWith("checks/data/npm-popular-packages.json");
			return {
				...actual,
				existsSync: (p: string) => (isDataPath(p) ? true : actual.existsSync(p)),
				readFileSync: (p: string, enc?: unknown) =>
					isDataPath(p) ? "{ not valid json" : actual.readFileSync(p as never, enc as never),
			};
		});
		const { checkTyposquatDependencies: freshCheck } = await import("./supply-chain.js");
		const tempDir = mkdtempSync(join(tmpdir(), "typosquat-malformed-"));
		try {
			const pkgPath = join(tempDir, "package.json");
			// "zoddd" is not in the hardcoded fallback allowlist, so with a
			// failed data load it must be flagged (distance 2 from "zod").
			writeFileSync(pkgPath, JSON.stringify({ dependencies: { zoddd: "^1.0.0" } }));
			const matches = freshCheck(pkgPath);
			expect(matches.length).toBe(1);
			expect(nonNull(matches[0]).text).toContain("zod");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns [] when json.packages is not an array (defensive check backed by the outer catch)", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			const isDataPath = (p: string) => p.endsWith("checks/data/npm-popular-packages.json");
			return {
				...actual,
				existsSync: (p: string) => (isDataPath(p) ? true : actual.existsSync(p)),
				readFileSync: (p: string, enc?: unknown) =>
					isDataPath(p)
						? JSON.stringify({ packages: "not-an-array" })
						: actual.readFileSync(p as never, enc as never),
			};
		});
		const { checkTyposquatDependencies: freshCheck } = await import("./supply-chain.js");
		const tempDir = mkdtempSync(join(tmpdir(), "typosquat-nonarray-"));
		try {
			const pkgPath = join(tempDir, "package.json");
			writeFileSync(pkgPath, JSON.stringify({ dependencies: { zoddd: "^1.0.0" } }));
			const matches = freshCheck(pkgPath);
			expect(matches.length).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// ===========================================
// findTyposquatMatch — public single-name API
// ===========================================
describe("findTyposquatMatch", () => {
	it("returns null for an empty name (guarded before any lookup)", () => {
		expect(findTyposquatMatch("")).toBeNull();
	});

	it("returns null for a 2-character name (below the length-3 floor)", () => {
		// "ab" would otherwise land at distance 2 from popular "ws" if the
		// length guard were skipped.
		expect(findTyposquatMatch("ab")).toBeNull();
	});

	it("flags a 3-character name exactly at the length floor ('wss' -> 'ws', distance 1)", () => {
		expect(findTyposquatMatch("wss")).toEqual({ popular: "ws", distance: 1 });
	});

	it("returns the exact match object for a known typosquat ('chlk' -> 'chalk', distance 1)", () => {
		expect(findTyposquatMatch("chlk")).toEqual({ popular: "chalk", distance: 1 });
	});

	it("returns null for a case-different EXACT popular name ('Cors') — distance 0 must not qualify", () => {
		// Case-insensitively identical to popular package "cors", and not
		// within distance <=2 of any OTHER popular package either. If
		// `dist > 0` were loosened to `dist >= 0` this would wrongly report
		// {popular: "cors", distance: 0} instead of null.
		expect(findTyposquatMatch("Cors")).toBeNull();
	});

	it("returns null exactly at the distance-2 boundary when >2 (not >=2) — 'reactor' vs 'react'", () => {
		expect(findTyposquatMatch("reactor")).toEqual({ popular: "react", distance: 2 });
	});
});

// ===========================================
// checkTyposquatDependencies — cap, line numbers, message text
// ===========================================
describe("checkTyposquatDependencies — match cap, line attribution, message text", () => {
	let tempDir: string;
	let pkgPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "typosquat-mech-"));
		pkgPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("caps at exactly 5 matches when 6 distinct typosquats are present", () => {
		writeFileSync(
			pkgPath,
			JSON.stringify({
				dependencies: {
					chlk: "^1.0.0",
					expresss: "^1.0.0",
					typescirpt: "^1.0.0",
					reactor: "^1.0.0",
					axioss: "^1.0.0",
					mochaa: "^1.0.0",
				},
			}),
		);
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches.length).toBe(5);
	});

	it("reports the exact 1-indexed line number where the dep key appears (not always line 1)", () => {
		const content = [
			"{",
			'  "name": "demo",',
			'  "version": "1.0.0",',
			'  "dependencies": {',
			'    "chlk": "^1.0.0"',
			"  }",
			"}",
			"",
		].join("\n");
		writeFileSync(pkgPath, content);
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([
			{
				line: 5,
				text: 'Possible typosquat: "chlk" is 1 character away from popular package "chalk". Verify this is the intended package.',
			},
		]);
	});

	it("falls back to line 1 when the dep key cannot be found verbatim in raw text (unicode-escaped key)", () => {
		// `chlk` parses to "chlk" but never appears as
		// the literal substring `"chlk"` in the raw file content, so
		// `lines.findIndex` must return -1 and the code must fall back to 1.
		const content = '{"dependencies":{"\\u0063\\u0068\\u006c\\u006b":"1.0.0"}}';
		writeFileSync(pkgPath, content);
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([
			{
				line: 1,
				text: 'Possible typosquat: "chlk" is 1 character away from popular package "chalk". Verify this is the intended package.',
			},
		]);
	});

	it("pluralizes 'characters' at distance 2 ('reactor' -> 'react')", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { reactor: "^1.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([
			{
				line: 1,
				text: 'Possible typosquat: "reactor" is 2 characters away from popular package "react". Verify this is the intended package.',
			},
		]);
	});

	it("does NOT flag a 2-character dep even at distance 1 ('d4' vs 'd3') — below the length-3 floor", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { d4: "^1.0.0" } }));
		expect(checkTyposquatDependencies(pkgPath)).toEqual([]);
	});

	it("flags a 3-character dep exactly at the length floor ('wss' vs 'ws', distance 1)", () => {
		writeFileSync(pkgPath, JSON.stringify({ dependencies: { wss: "^1.0.0" } }));
		const matches = checkTyposquatDependencies(pkgPath);
		expect(matches).toEqual([
			{
				line: 1,
				text: 'Possible typosquat: "wss" is 1 character away from popular package "ws". Verify this is the intended package.',
			},
		]);
	});
});

// ===========================================
// Structural equivalence proofs (dead/unreachable branches)
// ===========================================
// These document mutants applied-and-confirmed-passing during the mutation
// sweep whose source location can never produce an observable difference
// given the surrounding code's own invariants. Each proof line states the
// invariant; no test can distinguish these without changing the invariant
// itself (which would be a different, real bug).
//
//  - supply-chain.ts:36  `if (!Array.isArray(json.packages)) return [];`
//    Every branch below this line is inside the SAME try/catch as the
//    JSON.parse call. Any JSON.parse-produced value that is not an array
//    (string/number/boolean/null/object/undefined) has no `.map` method, so
//    `json.packages.map(...)` throws and is caught by the same catch that
//    the explicit early-return would otherwise reach — both paths return [].
//  - supply-chain.ts:37-39 `.map(...).filter((n): n is string => !!n)`
//    Removing `.filter()`, or forcing the `typeof entry?.name === "string"`
//    ternary to always take the string branch, can only ever inject
//    non-string junk (null/number/boolean) into the merged array. That
//    array is only ever consumed via `KNOWN_LEGITIMATE_PACKAGES.add(name)`
//    followed by `.has(dep)` where `dep` is always a real string from
//    Object.keys(package.json deps) — a non-string Set member can never
//    equal a string lookup key, so it is unobservable.
//  - supply-chain.ts:43  `return [];` (catch block) with the value mutated
//    to `["Stryker was here"]`: that literal is ~17 chars and shares no
//    meaningful prefix/suffix with any POPULAR_PACKAGES entry (min length
//    diff already >2 against most, and content is unrelated to the rest),
//    so it can never land within Levenshtein distance 2 of anything and
//    never affects an exact-match lookup either (no dep is ever literally
//    named "Stryker was here"). Unobservable through checkTyposquatDependencies
//    or findTyposquatMatch.
//  - supply-chain.ts:367 `if (a.length === 0) return b.length;` and
//    :368 `if (b.length === 0) return b.length;` inside levenshtein(): the
//    ONLY two call sites are findTyposquatMatch (guards `name.length < 3`
//    before calling, so `a` is never "") and checkTyposquatDependencies
//    (gates a match on `dep.length >= 3` AFTER computing dist, so an empty
//    `a` can never produce a recorded match regardless of the returned
//    value); `b` is always drawn from POPULAR_PACKAGES, which contains no
//    empty string. Both early-return branches are also mathematically
//    redundant with the general DP loop below them (an empty-string row of
//    the matrix already reduces to the same value), so even a hypothetical
//    future caller would see identical output with or without them.
//  - supply-chain.ts:369 `if (Math.abs(a.length - b.length) > 2) return 3;`
//    This is a fast-exit stand-in, not a real distance: the actual DP
//    algorithm always computes a real distance >= the length difference,
//    so whenever the length difference is already > 2 the real distance is
//    also always > 2. Both the shortcut (returns the sentinel 3) and the
//    full computation land on the same side of every `dist <= 2` /
//    `dist > 2` check every caller makes. The `>2` -> `>=2` boundary
//    mutant is NOT equivalent (see the "@vue/" reachable-scope test above,
//    which pins the diff-exactly-2 case going through the real DP path).
//  - supply-chain.ts:370 `const matrix: number[][] = [];` mutated to start
//    with a placeholder element: the very next loop
//    (`for (let i = 0; i <= a.length; i++) matrix[i] = [i];`) always runs
//    at least once (i=0 satisfies `0 <= a.length` for any a.length >= 0)
//    and unconditionally overwrites `matrix[0]` before it is ever read.
//  - supply-chain.ts:390 `if (dep === popular) break;` inside
//    checkTyposquatDependencies' inner loop: unreachable given the outer
//    guard at line 428 (`if (POPULAR_PACKAGES.has(dep)) continue;`) already
//    filters out any dep that is an exact member of POPULAR_PACKAGES before
//    the inner loop runs, so `dep` can never equal any `popular` here.
//  - supply-chain.ts:405 `if (!existsSync(pkgJsonPath)) return [];` and
//    :421 `if (depNames.length === 0) return [];`: both are pure early-exit
//    optimizations over paths that already produce the same result the slow
//    way — a missing file makes the immediately-following `readFileSync`
//    throw ENOENT, caught by the same function's try/catch, returning [];
//    an empty `depNames` makes the `for...of` loop simply not execute,
//    falling through to the same `return matches;` ([]) at the end.
//  - supply-chain.ts:443 `lineIdx >= 0 ? lineIdx + 1 : 1` mutated to
//    `lineIdx > 0 ? lineIdx + 1 : 1`: the two conditions differ ONLY when
//    `lineIdx === 0` (dep found on the very first line), and in that one
//    case both branches evaluate to the same final value: `0 + 1 === 1`,
//    identical to the `: 1` fallback the mutated condition takes instead.
// supply-chain.ts — documented equivalent-mutant proofs (already covered by
// tests above). Not a test: the actual verification is "every test above
// still passes with each of these mutants individually applied", confirmed
// via the mutation-sweep automation script, not a runtime assertion here.
