// Tests for the `tsconfig_strictness` check.
//
// Strategy: write real tsconfig files into a tmp directory so the `extends`
// chain resolution exercises the on-disk read path it does in production.
// Mocking fs here would hide the chain merge, which is the load-bearing
// invariant for the "base sets the flag, derived inherits" negative case.
//
// noUncheckedIndexedAccess is ADVISORY (never gated) — these tests assert it is
// skipped while the other four flags are still gated.
//
// Positive cases (check fires):
//   1. tsconfig with `strict: true` but missing a gated flag (exactOptionalPropertyTypes).
//   2. tsconfig missing all gated flags.
//   3. tsconfig where the `extends` chain disables a previously-enabled gated flag.
//
// Negative cases (check does NOT fire):
//   1. tsconfig with all flags explicitly `true`.
//   1b. tsconfig missing ONLY noUncheckedIndexedAccess (advisory).
//   2. Root composite tsconfig with only `references: [...]` (no compilerOptions).
//   3. tsconfig in `node_modules/` path.
//   4. tsconfig where the base sets all 5 flags and the derived inherits them.
//   5. JSONC: tsconfig with line comments + trailing commas still parses.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { checkTsconfigStrictness } from "../tsconfig-strictness.js";

// noUncheckedIndexedAccess is ADVISORY (never gated, see the check); these four
// are the gated flags the default verify gate still demands.
// noUnusedLocals / noUnusedParameters / allowUnreachableCode are likewise
// advisory (2026-09-01): the config-loosening gate blocks turning them OFF
// once on, but the check never demands them from a repo that hasn't.
const GATED_FLAGS = [
	"exactOptionalPropertyTypes",
	"noImplicitOverride",
	"noImplicitReturns",
	"noFallthroughCasesInSwitch",
] as const;

describe("checkTsconfigStrictness — positive cases", () => {
	let tmp: string;
	let configPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tscs-pos-"));
		configPath = join(tmp, "tsconfig.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// Case 1
	it("flags a missing GATED flag (exactOptionalPropertyTypes) even when `strict: true` is set", () => {
		const cfg = {
			compilerOptions: {
				strict: true,
				noUncheckedIndexedAccess: true,
				noImplicitOverride: true,
				noImplicitReturns: true,
				noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
				// exactOptionalPropertyTypes deliberately omitted
			},
		};
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("exactOptionalPropertyTypes");
		// Confirms the "Not covered by strict" framing is in the message.
		expect(nonNull(findings[0]).text).toContain("Not covered by `strict: true`");
	});

	// Case 2
	it("flags all GATED flags when tsconfig is only `strict: true` and nothing else", () => {
		const cfg = { compilerOptions: { strict: true } };
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		// The 4 gated flags are missing; the advisory flags are skipped.
		expect(findings).toHaveLength(4);
		const ids = findings.map((f) => f.text);
		for (const flag of GATED_FLAGS) {
			expect(ids.some((t) => t.includes(`\`compilerOptions.${flag}\``))).toBe(true);
		}
		// The advisory flag must NOT be gated.
		expect(ids.some((t) => t.includes("noUncheckedIndexedAccess"))).toBe(false);
	});

	// Case 3 — extends chain that re-disables a flag the base had set.
	it("flags a flag re-disabled by the derived tsconfig (derived wins)", () => {
		const basePath = join(tmp, "tsconfig.base.json");
		writeFileSync(
			basePath,
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noUncheckedIndexedAccess: true,
					exactOptionalPropertyTypes: true,
					noImplicitOverride: true,
					noImplicitReturns: true,
					noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
				},
			}),
		);

		const derived = {
			extends: "./tsconfig.base.json",
			compilerOptions: {
				// Derived explicitly disables one previously-enabled GATED flag.
				exactOptionalPropertyTypes: false,
			},
		};
		writeFileSync(configPath, JSON.stringify(derived, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(derived, null, 2), configPath);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).text).toContain("exactOptionalPropertyTypes");
	});
});

describe("checkTsconfigStrictness — negative cases", () => {
	let tmp: string;
	let configPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tscs-neg-"));
		configPath = join(tmp, "tsconfig.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// Case 1
	it("does NOT flag a tsconfig with all 5 flags explicitly true", () => {
		const cfg = {
			compilerOptions: {
				strict: true,
				noUncheckedIndexedAccess: true,
				exactOptionalPropertyTypes: true,
				noImplicitOverride: true,
				noImplicitReturns: true,
				noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
			},
		};
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		expect(findings).toEqual([]);
	});

	// Case 1b — noUncheckedIndexedAccess is advisory: missing it alone must not fire.
	it("does NOT gate on a missing noUncheckedIndexedAccess (advisory flag)", () => {
		const cfg = {
			compilerOptions: {
				strict: true,
				exactOptionalPropertyTypes: true,
				noImplicitOverride: true,
				noImplicitReturns: true,
				noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
				// noUncheckedIndexedAccess omitted — advisory, must NOT produce a finding.
			},
		};
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));
		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		expect(findings).toEqual([]);
	});

	// Case 2
	it("does NOT flag a composite root tsconfig with only `references` and no compilerOptions", () => {
		const cfg = {
			references: [{ path: "./packages/a" }, { path: "./packages/b" }],
			files: [],
		};
		writeFileSync(configPath, JSON.stringify(cfg, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg, null, 2), configPath);
		expect(findings).toEqual([]);
	});

	// Case 3
	it("does NOT fire on tsconfig.json inside node_modules", () => {
		const nmPath = join(tmp, "node_modules", "some-pkg", "tsconfig.json");
		mkdirSync(join(tmp, "node_modules", "some-pkg"), { recursive: true });
		writeFileSync(nmPath, JSON.stringify({ compilerOptions: {} }));

		const findings = checkTsconfigStrictness(
			JSON.stringify({ compilerOptions: {} }),
			nmPath,
		);
		expect(findings).toEqual([]);
	});

	// Case 4 — extends chain inherits all five flags, derived adds nothing.
	it("does NOT flag when the base tsconfig already sets every required flag", () => {
		const basePath = join(tmp, "tsconfig.base.json");
		writeFileSync(
			basePath,
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noUncheckedIndexedAccess: true,
					exactOptionalPropertyTypes: true,
					noImplicitOverride: true,
					noImplicitReturns: true,
					noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
				},
			}),
		);
		const derived = {
			extends: "./tsconfig.base.json",
			compilerOptions: { outDir: "./dist" },
		};
		writeFileSync(configPath, JSON.stringify(derived, null, 2));

		const findings = checkTsconfigStrictness(JSON.stringify(derived, null, 2), configPath);
		expect(findings).toEqual([]);
	});

	// Case 5 — JSONC tolerance (comments + trailing commas).
	it("parses tsconfig with line comments and trailing commas (JSONC)", () => {
		const jsonc = [
			"// Top-level comment",
			"{",
			'  "compilerOptions": {',
			'    "strict": true,',
			'    "noUncheckedIndexedAccess": true,',
			'    "exactOptionalPropertyTypes": true,',
			'    "noImplicitOverride": true,',
			'    "noImplicitReturns": true,',
			'    "noFallthroughCasesInSwitch": true, // trailing flag',
			"  },",
			"}",
		].join("\n");
		writeFileSync(configPath, jsonc);

		const findings = checkTsconfigStrictness(jsonc, configPath);
		expect(findings).toEqual([]);
	});

	// Case 6 — non-tsconfig basenames are skipped.
	it("does NOT fire on package.json or other .json files", () => {
		const pkgPath = join(tmp, "package.json");
		const pkgContent = JSON.stringify({ name: "foo", compilerOptions: {} });
		writeFileSync(pkgPath, pkgContent);

		const findings = checkTsconfigStrictness(pkgContent, pkgPath);
		expect(findings).toEqual([]);
	});

	// Case 7 — tsconfig.build.json variant fires the same way.
	it("fires on tsconfig.<variant>.json files (tsconfig.build.json)", () => {
		const variant = join(tmp, "tsconfig.build.json");
		const cfg = { compilerOptions: { strict: true } };
		writeFileSync(variant, JSON.stringify(cfg));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg), variant);
		expect(findings).toHaveLength(4);
	});
});

describe("checkTsconfigStrictness — robustness", () => {
	let tmp: string;
	let configPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tscs-robust-"));
		configPath = join(tmp, "tsconfig.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns [] on malformed JSON instead of throwing", () => {
		const malformed = '{ "compilerOptions": { ';
		writeFileSync(configPath, malformed);

		const findings = checkTsconfigStrictness(malformed, configPath);
		expect(findings).toEqual([]);
	});

	it("returns [] on an empty tsconfig that has neither compilerOptions nor references", () => {
		// Edge case: a fresh `{}` tsconfig. There's no `compilerOptions` and no
		// `references`, so it doesn't clearly hit either the project-list skip
		// or the strictness check — we fail open and report nothing.
		const empty = "{}";
		writeFileSync(configPath, empty);

		const findings = checkTsconfigStrictness(empty, configPath);
		// The detector reports the 4 gated flags missing (noUncheckedIndexedAccess
		// is advisory) because the merged object is empty and the file does NOT
		// match the references-only project shape.
		expect(findings).toHaveLength(4);
	});

	it("handles a broken extends path by treating the chain as ending at this file", () => {
		// `./does-not-exist.json` cannot be read; the merge collapses to the
		// derived file's own compilerOptions, which has all 5 flags.
		const cfg = {
			extends: "./does-not-exist.json",
			compilerOptions: {
				noUncheckedIndexedAccess: true,
				exactOptionalPropertyTypes: true,
				noImplicitOverride: true,
				noImplicitReturns: true,
				noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
			},
		};
		writeFileSync(configPath, JSON.stringify(cfg));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg), configPath);
		expect(findings).toEqual([]);
	});

	it("returns [] for empty content (safeJsoncParse's falsy-text guard)", () => {
		const findings = checkTsconfigStrictness("", configPath);
		expect(findings).toEqual([]);
	});

	it("returns [] when the parsed JSON is an array, not an object", () => {
		const findings = checkTsconfigStrictness("[1,2,3]", configPath);
		expect(findings).toEqual([]);
	});

	it("treats a non-object compilerOptions (array) as absent, reporting all 4 gated flags missing", () => {
		const cfg = { compilerOptions: [] };
		writeFileSync(configPath, JSON.stringify(cfg));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg), configPath);
		expect(findings).toHaveLength(4);
	});

	it("skips a base config that is unreadable (a directory named like a file)", () => {
		// `safeReadJsonc` catches the readFileSync EISDIR error and returns null,
		// so the chain collapses to the derived file's own compilerOptions.
		mkdirSync(join(tmp, "badbase.json"));
		const cfg = {
			extends: "./badbase.json",
			compilerOptions: {
				strict: true,
				noUncheckedIndexedAccess: true,
				exactOptionalPropertyTypes: true,
				noImplicitOverride: true,
				noImplicitReturns: true,
				noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
			},
		};
		writeFileSync(configPath, JSON.stringify(cfg));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg), configPath);
		expect(findings).toEqual([]);
	});

	it("resolves an extends reference with the `.json` suffix omitted", () => {
		const basePath = join(tmp, "tsconfig.base.json");
		writeFileSync(
			basePath,
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noUncheckedIndexedAccess: true,
					exactOptionalPropertyTypes: true,
					noImplicitOverride: true,
					noImplicitReturns: true,
					noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
				},
			}),
		);
		const derived = { extends: "./tsconfig.base", compilerOptions: {} };
		writeFileSync(configPath, JSON.stringify(derived));

		const findings = checkTsconfigStrictness(JSON.stringify(derived), configPath);
		expect(findings).toEqual([]);
	});

	it("resolves an absolute-path extends reference", () => {
		const basePath = join(tmp, "base-abs.json");
		writeFileSync(
			basePath,
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noUncheckedIndexedAccess: true,
					exactOptionalPropertyTypes: true,
					noImplicitOverride: true,
					noImplicitReturns: true,
					noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
				},
			}),
		);
		const derived = { extends: basePath, compilerOptions: {} };
		writeFileSync(configPath, JSON.stringify(derived));

		const findings = checkTsconfigStrictness(JSON.stringify(derived), configPath);
		expect(findings).toEqual([]);
	});

	it("treats a package-name extends reference (not relative/absolute) as unresolvable and falls open", () => {
		const cfg = {
			extends: "@internal/tsconfig-base",
			compilerOptions: { strict: true },
		};
		writeFileSync(configPath, JSON.stringify(cfg));

		const findings = checkTsconfigStrictness(JSON.stringify(cfg), configPath);
		// resolveExtendsPath returns null for a bare package specifier, so the
		// chain collapses to this file's own compilerOptions — all 4 gated
		// flags (beyond `strict`) are still missing.
		expect(findings).toHaveLength(4);
	});

	it("breaks an extends cycle (A -> B -> A) and still merges B's flags into A", () => {
		const bPath = join(tmp, "tsconfig.b.json");
		writeFileSync(
			bPath,
			JSON.stringify({
				extends: "./tsconfig.json",
				compilerOptions: {
					strict: true,
					noUncheckedIndexedAccess: true,
					exactOptionalPropertyTypes: true,
					noImplicitOverride: true,
					noImplicitReturns: true,
					noFallthroughCasesInSwitch: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				allowUnreachableCode: false,
				},
			}),
		);
		const aCfg = { extends: "./tsconfig.b.json" };
		writeFileSync(configPath, JSON.stringify(aCfg));

		const findings = checkTsconfigStrictness(JSON.stringify(aCfg), configPath);
		expect(findings).toEqual([]);
	});

	it("caps extends-chain recursion at 8 hops, dropping flags only reachable past the cap", () => {
		// Build a 9-file linear chain (root + b1..b8). At the b8 call the
		// recursion depth reaches 8 (MAX_DEPTH), so the walk stops there
		// without ever reading b8's own compilerOptions contribution further
		// down. None of the intermediate files declare any flags, so the
		// merged result is empty and every gated flag is reported missing.
		for (let i = 1; i <= 8; i++) {
			const next = i < 8 ? { extends: `./b${i + 1}.json` } : {};
			writeFileSync(join(tmp, `b${i}.json`), JSON.stringify(next));
		}
		const root = { extends: "./b1.json" };
		writeFileSync(configPath, JSON.stringify(root));

		const findings = checkTsconfigStrictness(JSON.stringify(root), configPath);
		expect(findings).toHaveLength(4);
	});

	it("resolves an extends chain with a relative (non-absolute) checked-file path", () => {
		// No extends field, so the mergeExtendsChain absPath ternary's
		// non-absolute branch is exercised without needing further disk reads.
		const cfg = { compilerOptions: { strict: true } };
		const findings = checkTsconfigStrictness(JSON.stringify(cfg), "tsconfig.json");
		expect(findings).toHaveLength(4);
	});
});
