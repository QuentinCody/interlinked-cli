// Tests for the defensive-primitive coverage detector — the adaptation
// of curl's curlx_str_number lesson into the harness ratchet model.
// Verifies: discovery scans for project wrappers around unsafe
// builtins, threshold-gates them, caches discovery, and counts
// bare-builtin violations in arbitrary file content.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	cachePath,
	capturePrimitiveViolations,
	countBareBuiltinCalls,
	countViolations,
	DISCOVERY_TTL_MS,
	discoverPrimitives,
	findWrappersInContent,
	getUnsafeBuiltins,
	listSourceFiles,
	loadCache,
	PRIMITIVE_CALL_SITE_THRESHOLD,
	refreshIfStale,
	saveCache,
} from "../discovered-primitives.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-dp-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const full = join(tmp, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

describe("listSourceFiles", () => {
	it("returns TS/JS/MJS files and skips vendored/generated dirs", () => {
		write("src/a.ts", "");
		write("src/b.mjs", "");
		write("src/c.tsx", "");
		write("src/sub/d.js", "");
		write("node_modules/foo/index.js", "");
		write("dist/build.js", "");
		write(".git/foo.ts", "");
		write("README.md", "");

		const files = listSourceFiles(tmp);
		const rel = files.map((f) => f.replace(`${tmp}/`, "")).sort();
		expect(rel).toEqual([
			"src/a.ts",
			"src/b.mjs",
			"src/c.tsx",
			"src/sub/d.js",
		]);
	});

	it("handles empty repos without throwing", () => {
		expect(listSourceFiles(tmp)).toEqual([]);
	});

	it("survives unreadable subdirectories (best-effort walk)", () => {
		// We can't easily make a directory unreadable cross-platform in
		// the test environment, so this is a smoke test that the function
		// completes even with weird/symlinked content.
		write("src/a.ts", "");
		expect(() => listSourceFiles(tmp)).not.toThrow();
		// Pins the non-default outcome too: a "swallow every error and
		// return []" stub would also never throw, so the smoke test alone
		// can't tell a real best-effort walk from one that gives up silently.
		expect(listSourceFiles(tmp)).toEqual([join(tmp, "src/a.ts")]);
	});
});

describe("getUnsafeBuiltins", () => {
	it("exposes the canonical list with known builtins", () => {
		const builtins = getUnsafeBuiltins();
		const names = builtins.map((b) => b.name);
		expect(names).toContain("parseInt");
		expect(names).toContain("JSON.parse");
		expect(names).toContain("eval");
		expect(names).toContain("fetch");
	});
});

describe("findWrappersInContent", () => {
	const parseInt_ = getUnsafeBuiltins().find((b) => b.name === "parseInt");
	if (!parseInt_) throw new Error("parseInt builtin not found");

	it("detects a function-declaration wrapper that calls parseInt", () => {
		const content = `
			function safeParseInt(s: string, max = 1000): number {
				const n = parseInt(s, 10);
				if (Number.isNaN(n) || n > max) throw new Error("bad");
				return n;
			}
		`;
		expect(findWrappersInContent(content, parseInt_)).toContain("safeParseInt");
	});

	it("detects an arrow-function wrapper", () => {
		const content = `
			export const parseNumberStrict = (s: string): number => {
				const n = parseInt(s, 10);
				return n;
			};
		`;
		expect(findWrappersInContent(content, parseInt_)).toContain("parseNumberStrict");
	});

	it("ignores functions whose names lack hint words", () => {
		// `randomThing` calls parseInt but has no hint word — not a
		// wrapper-y name, so it should not be flagged as a primitive.
		const content = `
			function randomThing(s: string): number {
				return parseInt(s, 10);
			}
		`;
		expect(findWrappersInContent(content, parseInt_)).toEqual([]);
	});

	it("ignores files with no parseInt call (fast path)", () => {
		const content = `
			function parseSomething(s: string): string {
				return s.toUpperCase();
			}
		`;
		expect(findWrappersInContent(content, parseInt_)).toEqual([]);
	});

	it("ignores parseInt calls inside block comments", () => {
		const content = `
			/* example: parseInt(x, 10) */
			function parseConfig(s: string): string {
				return s;
			}
		`;
		expect(findWrappersInContent(content, parseInt_)).toEqual([]);
	});
});

describe("countBareBuiltinCalls", () => {
	const parseInt_ = getUnsafeBuiltins().find((b) => b.name === "parseInt");
	if (!parseInt_) throw new Error("parseInt builtin not found");

	it("counts bare parseInt calls", () => {
		const content = `
			const a = parseInt(x, 10);
			const b = parseInt(y, 10);
			const c = parseInt(z, 10);
		`;
		expect(countBareBuiltinCalls(content, parseInt_, [])).toBe(3);
	});

	it("does NOT count parseInt calls inside a known wrapper's body", () => {
		// safeParseInt's own body calls parseInt — that's correct, not a
		// violation. Other call sites are violations.
		const content = `
			function safeParseInt(s: string): number {
				const n = parseInt(s, 10);
				return n;
			}
			const a = parseInt(x, 10);
			const b = parseInt(y, 10);
		`;
		expect(countBareBuiltinCalls(content, parseInt_, ["safeParseInt"])).toBe(2);
	});

	it("does NOT count parseInt in line comments", () => {
		const content = `
			// const x = parseInt(s, 10);  -- example
			const y = parseInt(z, 10);
		`;
		expect(countBareBuiltinCalls(content, parseInt_, [])).toBe(1);
	});

	it("does NOT count parseInt in string literals", () => {
		const content = `
			const msg = "use parseInt(s, 10) for parsing";
			const tpl = \`example: parseInt(x, 10)\`;
			const single = 'parseInt(y, 10)';
			const real = parseInt(z, 10);
		`;
		expect(countBareBuiltinCalls(content, parseInt_, [])).toBe(1);
	});

	it("does NOT count method calls like foo.parseInt(", () => {
		// Method access — the regex's negative lookbehind excludes it.
		const content = `
			const a = obj.parseInt(s);
			const b = parseInt(s, 10);
		`;
		expect(countBareBuiltinCalls(content, parseInt_, [])).toBe(1);
	});

	it("returns 0 on empty content", () => {
		expect(countBareBuiltinCalls("", parseInt_, [])).toBe(0);
	});

	it("leaves an arrow wrapper's own body un-excised when it has no '{' anywhere (bodyOpen === -1)", () => {
		// The excision pass finds the declaration match then searches for the
		// next "{" in the WHOLE remaining string to bound the body. An arrow
		// function with an expression body has no "{" at all — when the file
		// has no braces anywhere after the match, that search comes back -1
		// and the wrapper's own body is left un-excised, so its internal
		// parseInt call is (incorrectly, but documented) counted as a bare
		// violation alongside the real external call.
		const content =
			"const safeParseInt = (s: string): number => parseInt(s, 10);\n" +
			"const a = parseInt(x, 10);";
		expect(content.includes("{")).toBe(false);
		expect(countBareBuiltinCalls(content, parseInt_, ["safeParseInt"])).toBe(2);
	});
});

describe("discoverPrimitives", () => {
	it("returns empty when no wrapper meets the call-site threshold", () => {
		// One wrapper, one call-site → below threshold.
		write(
			"src/wrap.ts",
			`
				export function safeParseInt(s: string): number {
					return parseInt(s, 10);
				}
				const x = safeParseInt("42");
			`,
		);
		expect(discoverPrimitives(tmp)).toEqual([]);
	});

	it("discovers a wrapper that meets the call-site threshold", () => {
		// Wrapper declared in one file + called ≥ threshold times across
		// a second file. Discovery picks it up.
		write(
			"src/lib/safe.ts",
			`
				export function safeParseInt(s: string, max = 1000): number {
					const n = parseInt(s, 10);
					if (n > max) throw new Error("bad");
					return n;
				}
			`,
		);
		const calls: string[] = [];
		for (let i = 0; i < PRIMITIVE_CALL_SITE_THRESHOLD + 2; i++) {
			calls.push(`const x${i} = safeParseInt("${i}");`);
		}
		write("src/uses.ts", `import { safeParseInt } from "./lib/safe.js";\n${calls.join("\n")}`);

		const prims = discoverPrimitives(tmp);
		const parseIntPrim = prims.find((p) => p.unsafeBuiltin === "parseInt");
		expect(parseIntPrim).toBeDefined();
		expect(parseIntPrim?.wrapperName).toBe("safeParseInt");
		expect(parseIntPrim?.callSiteCount).toBeGreaterThanOrEqual(PRIMITIVE_CALL_SITE_THRESHOLD);
		expect(parseIntPrim?.declarationFile).toContain("safe.ts");
	});

	it("picks the most-called wrapper when several candidates exist for one builtin", () => {
		// Two wrappers, one called 12x, one called 11x. The 12x one wins.
		write(
			"src/lib/a.ts",
			`
				export function safeParseInt(s: string): number {
					return parseInt(s, 10);
				}
				export function parseIntStrict(s: string): number {
					return parseInt(s, 10);
				}
			`,
		);
		const callsA = Array.from({ length: 12 }, (_, i) => `safeParseInt("${i}");`).join("\n");
		const callsB = Array.from({ length: 11 }, (_, i) => `parseIntStrict("${i}");`).join("\n");
		write("src/uses.ts", `${callsA}\n${callsB}`);

		const prims = discoverPrimitives(tmp);
		const winner = prims.find((p) => p.unsafeBuiltin === "parseInt");
		expect(winner?.wrapperName).toBe("safeParseInt");
		expect(winner?.callSiteCount).toBe(12);
	});

	it("returns empty for a repo with no source files", () => {
		expect(discoverPrimitives(tmp)).toEqual([]);
	});

	it("skips a file that fails to read (tryReadFile's catch) without throwing", () => {
		// A real wrapper that meets the threshold, plus a sibling file whose
		// permissions block reads once discovery reaches it — statSync (used
		// by listSourceFiles to decide isFile()) succeeds, but readFileSync
		// throws EACCES; tryReadFile's catch swallows it and discovery
		// continues over the remaining files instead of crashing.
		write(
			"src/lib/safe.ts",
			`
				export function safeParseInt(s: string): number {
					return parseInt(s, 10);
				}
			`,
		);
		const calls = Array.from(
			{ length: PRIMITIVE_CALL_SITE_THRESHOLD + 1 },
			(_, i) => `safeParseInt("${i}");`,
		).join("\n");
		write("src/uses.ts", calls);
		write("src/blocked.ts", "const irrelevant = parseInt('99', 10);");
		chmodSync(join(tmp, "src/blocked.ts"), 0o000);
		try {
			const prims = discoverPrimitives(tmp);
			expect(prims.find((p) => p.wrapperName === "safeParseInt")).toBeDefined();
		} finally {
			// Restore so the outer afterEach's rmSync can clean the tree up.
			chmodSync(join(tmp, "src/blocked.ts"), 0o644);
		}
	});
});

describe("cache: loadCache / saveCache / cachePath", () => {
	it("cachePath returns .interlinked/discovered-primitives.json under repoRoot", () => {
		expect(cachePath(tmp)).toBe(join(tmp, ".interlinked", "discovered-primitives.json"));
	});

	it("loadCache returns null when file is absent", () => {
		expect(loadCache(tmp)).toBeNull();
	});

	it("saveCache + loadCache round-trips a valid cache", () => {
		const cache = {
			version: 1 as const,
			discoveredAt: 1000,
			primitives: [
				{
					wrapperName: "safeParseInt",
					unsafeBuiltin: "parseInt",
					callSiteCount: 23,
					declarationFile: "src/lib/safe.ts",
					discoveredAt: 1000,
				},
			],
			disabled: [],
		};
		saveCache(tmp, cache);
		const loaded = loadCache(tmp);
		expect(loaded).toEqual(cache);
	});

	it("loadCache returns null on malformed JSON instead of throwing", () => {
		// Defensive: a hand-edited / partially-written cache must not
		// crash the harness — we silently re-discover.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(cachePath(tmp), "{ not valid json");
		expect(loadCache(tmp)).toBeNull();
	});

	it("loadCache returns null on wrong schema version", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(cachePath(tmp), JSON.stringify({ version: 999, primitives: [] }));
		expect(loadCache(tmp)).toBeNull();
	});

	it("loadCache preserves a `disabled` list from the cache", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			cachePath(tmp),
			JSON.stringify({
				version: 1,
				discoveredAt: 1,
				primitives: [],
				disabled: ["foo"],
			}),
		);
		expect(loadCache(tmp)?.disabled).toEqual(["foo"]);
	});
});

describe("refreshIfStale", () => {
	it("triggers fresh discovery when cache is absent", () => {
		write(
			"src/lib/safe.ts",
			`
				export function safeParseInt(s: string): number {
					return parseInt(s, 10);
				}
			`,
		);
		const calls = Array.from(
			{ length: PRIMITIVE_CALL_SITE_THRESHOLD + 1 },
			(_, i) => `safeParseInt("${i}");`,
		).join("\n");
		write("src/uses.ts", calls);

		const prims = refreshIfStale(tmp);
		expect(prims.some((p) => p.wrapperName === "safeParseInt")).toBe(true);
		// Cache should now exist.
		expect(loadCache(tmp)).not.toBeNull();
	});

	it("reuses cache when within TTL", () => {
		const cached = {
			version: 1 as const,
			discoveredAt: 1_000_000_000_000,
			primitives: [
				{
					wrapperName: "cachedWrapper",
					unsafeBuiltin: "parseInt",
					callSiteCount: 99,
					declarationFile: "src/cached.ts",
					discoveredAt: 1_000_000_000_000,
				},
			],
			disabled: [],
		};
		saveCache(tmp, cached);
		// Now = 1s after cache — within any reasonable TTL.
		const prims = refreshIfStale(tmp, 1_000_000_001_000, 60_000);
		expect(prims).toHaveLength(1);
		expect(nonNull(prims[0]).wrapperName).toBe("cachedWrapper");
	});

	it("re-discovers when cache is older than TTL", () => {
		const cached = {
			version: 1 as const,
			discoveredAt: 1_000_000_000_000,
			primitives: [
				{
					wrapperName: "stale",
					unsafeBuiltin: "parseInt",
					callSiteCount: 99,
					declarationFile: "src/stale.ts",
					discoveredAt: 1_000_000_000_000,
				},
			],
			disabled: [],
		};
		saveCache(tmp, cached);
		// No source files declare 'stale'; re-discovery returns nothing.
		const prims = refreshIfStale(tmp, 1_000_000_000_000 + 999_999_999, 1000);
		expect(prims.find((p) => p.wrapperName === "stale")).toBeUndefined();
	});

	it("respects the `disabled` list when filtering primitives", () => {
		write(
			"src/lib/safe.ts",
			`
				export function safeParseInt(s: string): number {
					return parseInt(s, 10);
				}
			`,
		);
		const calls = Array.from(
			{ length: PRIMITIVE_CALL_SITE_THRESHOLD + 1 },
			(_, i) => `safeParseInt("${i}");`,
		).join("\n");
		write("src/uses.ts", calls);

		// Pre-seed cache with disabled list, ttl=0 forces re-discover.
		saveCache(tmp, {
			version: 1,
			discoveredAt: 0,
			primitives: [],
			disabled: ["safeParseInt"],
		});
		// Use a fixed clock — anything > 0 with ttl=0 forces re-discover.
		const prims = refreshIfStale(tmp, 1_700_000_000_000, 0);
		// Discovery DID find safeParseInt, but the disabled list filters
		// it out — primitive is enforced nowhere.
		expect(prims.find((p) => p.wrapperName === "safeParseInt")).toBeUndefined();
	});
});

describe("DISCOVERY_TTL_MS", () => {
	it("is one day in milliseconds (default cache window)", () => {
		// Public-API tuning knob — exposed for CI-driven runs that want
		// fresh discovery every push. Pin the value so a stealth bump
		// shows up in diffs.
		expect(DISCOVERY_TTL_MS).toBe(24 * 60 * 60 * 1000);
	});
});

describe("capturePrimitiveViolations", () => {
	it("returns undefined when the project has no discovered primitives", () => {
		// Empty repo → no wrappers detected → nothing to ratchet. The
		// helper fails open so PostToolUse doesn't fire bogus warnings.
		expect(capturePrimitiveViolations(tmp, "const x = parseInt('1');")).toBeUndefined();
	});

	it("returns a record of bare-builtin violations once primitives are discovered", () => {
		// Seed: wrapper declared + called enough times to be a primitive.
		write(
			"src/lib/safe.ts",
			`
				export function safeParseInt(s: string): number {
					return parseInt(s, 10);
				}
			`,
		);
		const calls = Array.from(
			{ length: PRIMITIVE_CALL_SITE_THRESHOLD + 1 },
			(_, i) => `safeParseInt("${i}");`,
		).join("\n");
		write("src/uses.ts", calls);

		const fileContent = `
			const a = parseInt("1", 10);  // 2 violations
			const b = parseInt("2", 10);
			const c = safeParseInt("3");  // not a violation
		`;
		const result = capturePrimitiveViolations(tmp, fileContent);
		expect(result).toBeDefined();
		expect(result?.safeParseInt).toBe(2);
	});

	it("fails open (undefined) when discovery itself throws, instead of propagating", () => {
		// repoRoot points at a FILE, not a directory. discoverPrimitives()
		// itself degrades gracefully (readdirSync fails, walk yields []),
		// but refreshIfStale's subsequent saveCache() then tries to
		// mkdirSync(".interlinked", {recursive:true}) *inside* that file,
		// which throws ENOTDIR — capturePrimitiveViolations's catch turns
		// that into undefined rather than crashing the PostToolUse ratchet.
		const fakeRepoRoot = join(tmp, "not-a-directory.txt");
		writeFileSync(fakeRepoRoot, "i am a file, not a repo root");
		expect(capturePrimitiveViolations(fakeRepoRoot, "const x = parseInt('1');")).toBeUndefined();
	});

	it("returns undefined when the file has no bare-builtin calls at all", () => {
		// Discovery still fires but no violations land in the result map.
		write(
			"src/lib/safe.ts",
			`
				export function safeParseInt(s: string): number {
					return parseInt(s, 10);
				}
			`,
		);
		const calls = Array.from(
			{ length: PRIMITIVE_CALL_SITE_THRESHOLD + 1 },
			(_, i) => `safeParseInt("${i}");`,
		).join("\n");
		write("src/uses.ts", calls);

		// File content has zero parseInt calls → entry would be 0 but
		// we still emit it so the ratchet can compare. Verify the shape.
		const result = capturePrimitiveViolations(tmp, "export const x = 1;");
		expect(result?.safeParseInt).toBe(0);
	});
});

describe("countViolations", () => {
	it("returns 0 for files with no primitive's underlying builtin", () => {
		const content = "const x = 1 + 2; export {};";
		const violations = countViolations(content, [
			{
				wrapperName: "safeParseInt",
				unsafeBuiltin: "parseInt",
				callSiteCount: 99,
				declarationFile: "src/lib/safe.ts",
				discoveredAt: 0,
			},
		]);
		expect(violations.get("safeParseInt")).toBe(0);
	});

	it("counts bare unsafe-builtin calls in a file as violations", () => {
		const content = `
			const a = parseInt("1", 10);
			const b = parseInt("2", 10);
			const c = safeParseInt("3");
		`;
		const violations = countViolations(content, [
			{
				wrapperName: "safeParseInt",
				unsafeBuiltin: "parseInt",
				callSiteCount: 99,
				declarationFile: "src/lib/safe.ts",
				discoveredAt: 0,
			},
		]);
		expect(violations.get("safeParseInt")).toBe(2);
	});

	it("excludes parseInt usage inside the wrapper's own declaration", () => {
		const content = `
			export function safeParseInt(s: string): number {
				return parseInt(s, 10);  // legitimate — wrapper body
			}
			const a = parseInt("1", 10);  // violation
		`;
		const violations = countViolations(content, [
			{
				wrapperName: "safeParseInt",
				unsafeBuiltin: "parseInt",
				callSiteCount: 99,
				declarationFile: "src/lib/safe.ts",
				discoveredAt: 0,
			},
		]);
		expect(violations.get("safeParseInt")).toBe(1);
	});

	it("returns an empty map when no primitives are passed", () => {
		expect(countViolations("const x = parseInt('1');", [])).toEqual(new Map());
	});
});
