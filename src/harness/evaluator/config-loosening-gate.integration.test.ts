import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { HarnessEvent } from "../types.js";
import {
	detectConfigLoosening,
	evaluateConfigLooseningForEvent,
	readHeadVersion,
	reconstructEditContent,
	safeJsonParse,
} from "./config-loosening-gate.js";

/** Minimal PreToolUse event factory — only the fields the gate reads. */
function makeEvent(toolInput: Record<string, unknown>, cwd?: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: toolInput,
		timestamp: "2026-06-07T00:00:00Z",
		...(cwd ? { cwd } : {}),
	};
}

/**
 * Spin up a throwaway git repo with one committed file so the event-level
 * gate (which reads `git show HEAD:<rel>`) has a real baseline to diff
 * against. Returns the git toplevel path (canonicalized — on macOS the
 * `mkdtemp` path lives under the `/var → /private/var` symlink, and the
 * source resolves file paths with `path.resolve`, so we must hand the gate
 * the same resolved root git itself reports or `relative()` produces a
 * `..`-prefixed path and the gate fails open). Caller is responsible for
 * cleanup via `rmSync`.
 */
function makeRepoWithCommittedFile(relPath: string, committedContent: string): string {
	const raw = mkdtempSync(join(tmpdir(), "clg-gate-"));
	execSync("git init -q -b main", { cwd: raw });
	execSync("git config user.email test@example.com", { cwd: raw });
	execSync("git config user.name test", { cwd: raw });
	writeFileSync(join(raw, relPath), committedContent);
	execSync(`git add ${relPath}`, { cwd: raw });
	execSync('git commit -q -m "initial"', { cwd: raw });
	return execSync("git rev-parse --show-toplevel", { cwd: raw, encoding: "utf-8" }).trim();
}

describe("detectConfigLoosening — tsconfig.json", () => {
	it("flags `strict: true` → `strict: false`", () => {
		// Flipping strict from true → false also flips every implied
		// subflag (noImplicitAny, strictNullChecks, …) from effectively
		// true to effectively false. The check surfaces all of them so
		// the user sees the full blast radius.
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		const rules = findings.map((f) => f.rule);
		expect(rules).toContain("strict");
		expect(rules).toContain("noImplicitAny");
	});

	it("flags `noImplicitAny: true` → `noImplicitAny: false`", () => {
		const before = `{ "compilerOptions": { "noImplicitAny": true } }`;
		const after = `{ "compilerOptions": { "noImplicitAny": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
	});

	it("flags `strictNullChecks: true` → `strictNullChecks: false`", () => {
		const before = `{ "compilerOptions": { "strictNullChecks": true } }`;
		const after = `{ "compilerOptions": { "strictNullChecks": false } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after).length).toBe(1);
	});

	it("does not flag adding a new strict flag", () => {
		const before = `{ "compilerOptions": {} }`;
		const after = `{ "compilerOptions": { "strict": true } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("does not flag tightening (false → true)", () => {
		const before = `{ "compilerOptions": { "strict": false } }`;
		const after = `{ "compilerOptions": { "strict": true } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("flags adding a `noImplicitAny: false` override under `strict: true`", () => {
		// strict: true makes noImplicitAny effectively true. Adding an
		// explicit `noImplicitAny: false` is a real loosening even though
		// the literal `noImplicitAny` was undefined before.
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": true, "noImplicitAny": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("noImplicitAny");
	});

	it("flags adding `strictNullChecks: false` override under `strict: true`", () => {
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": true, "strictNullChecks": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("strictNullChecks");
	});

	it("does not flag adding a strict subflag override under `strict: false`", () => {
		// If strict was already false, adding noImplicitAny: false isn't a
		// loosening — the umbrella was already off.
		const before = `{ "compilerOptions": { "strict": false } }`;
		const after = `{ "compilerOptions": { "strict": false, "noImplicitAny": false } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("flags removing `noUncheckedIndexedAccess: true` (TS default is false)", () => {
		// noUncheckedIndexedAccess is NOT implied by strict — its TS default
		// is false. Removing an explicit `true` therefore IS a loosening.
		const before = `{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true } }`;
		const after = `{ "compilerOptions": { "strict": true } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("noUncheckedIndexedAccess");
	});

	it("flags removing `strict: true` entirely", () => {
		// Removing strict drops every implied subflag from true → false (TS
		// defaults each to false when strict is absent).
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": {} }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		// Should fire on `strict` itself plus every one of the 8 implied
		// subflags. Keeping this exact catches a stale/missing umbrella entry.
		const rules = findings.map((f) => f.rule).sort();
		expect(rules).toEqual([
			"alwaysStrict",
			"noImplicitAny",
			"noImplicitThis",
			"strict",
			"strictBindCallApply",
			"strictFunctionTypes",
			"strictNullChecks",
			"strictPropertyInitialization",
			"useUnknownInCatchVariables",
		]);
	});

	it("normalizes Windows separators before recognizing config paths", () => {
		const findings = detectConfigLoosening(
			"packages\\api\\tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
			`{ "compilerOptions": { "strict": false } }`,
		);
		expect(findings.map((f) => f.rule)).toContain("strict");
	});

	it("does not throw for a null compilerOptions object", () => {
		expect(() =>
			detectConfigLoosening(
				"tsconfig.json",
				`{ "compilerOptions": null }`,
				`{ "compilerOptions": null }`,
			),
		).not.toThrow();
		expect(
			detectConfigLoosening(
				"tsconfig.json",
				`{ "compilerOptions": null }`,
				`{ "compilerOptions": null }`,
			),
		).toEqual([]);
	});

	it("does not flag removing a flag that's already false", () => {
		const before = `{ "compilerOptions": { "noImplicitReturns": false } }`;
		const after = `{ "compilerOptions": {} }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});
});

describe("detectConfigLoosening — package.json", () => {
	it("flags engines.node version drop", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ "engines": { "node": ">=18.0.0" } }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("engines.node");
	});

	it("matches a Windows-style nested package.json path", () => {
		const findings = detectConfigLoosening(
			"packages\\api\\package.json",
			`{ "engines": { "node": ">=22.0.0" } }`,
			`{ "engines": { "node": ">=18.0.0" } }`,
		);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).file).toBe("packages\\api\\package.json");
	});

	it("flags engines.node removal entirely (no floor at all)", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("engines.node");
	});

	// test-contract: public-api — removing engines.node reports removal (not a version downgrade) and preserves the absent after value
	it("distinguishes engines.node removal from a lower declared floor", () => {
		const [finding] = detectConfigLoosening(
			"package.json",
			`{ "engines": { "node": ">=22.0.0" } }`,
			`{ "name": "x" }`,
		);
		expect(finding).toEqual({
			rule: "engines.node",
			before: ">=22.0.0",
			after: undefined,
			file: "package.json",
			message:
				"engines.node removed (was >=22.0.0). The package no longer declares a Node version floor; consumers on older Node may install successfully and crash at runtime. Restore the floor or document why no minimum is appropriate.",
		});
	});

	it("flags engines block removal", () => {
		const before = `{ "engines": { "node": ">=22.0.0" }, "name": "x" }`;
		const after = `{ "name": "x" }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
	});

	it("flags removal of test script", () => {
		const before = `{ "scripts": { "test": "vitest run", "build": "tsup" } }`;
		const after = `{ "scripts": { "build": "tsup" } }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("scripts.test");
	});

	it("does not flag adding a script", () => {
		const before = `{ "scripts": { "build": "tsup" } }`;
		const after = `{ "scripts": { "build": "tsup", "test": "vitest" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});
});

describe("detectConfigLoosening — non-config files", () => {
	it("returns empty for non-config file paths", () => {
		expect(
			detectConfigLoosening(
				"src/lib/foo.ts",
				`{"strict": true}`,
				`{"strict": false}`,
			),
		).toEqual([]);
	});
});

describe("reconstructEditContent — Edit tool reconstruction", () => {
	it("reconstructs from old_string + new_string", async () => {
		const { reconstructEditContent } = await import("./config-loosening-gate.js");
		const before = `{ "compilerOptions": { "strict": true } }`;
		const result = reconstructEditContent(before, '"strict": true', '"strict": false');
		expect(result).toBe(`{ "compilerOptions": { "strict": false } }`);
	});

	it("returns null when old_string is not present in disk content", async () => {
		const { reconstructEditContent } = await import("./config-loosening-gate.js");
		const result = reconstructEditContent("{}", "missing", "x");
		expect(result).toBeNull();
	});

	it("returns null when old_string is ambiguous (matches multiple times)", async () => {
		const { reconstructEditContent } = await import("./config-loosening-gate.js");
		// `replaceAll` is intentionally unsupported — agents pass replace_all=true
		// for that, and we can't reproduce ambiguity safely. Return null so the
		// caller falls back to the next gate rather than firing on the wrong
		// reconstructed content.
		const result = reconstructEditContent("aa\naa", "aa", "bb");
		expect(result).toBeNull();
	});

	it("replaces an old_string at index zero", () => {
		expect(reconstructEditContent("aa", "aa", "bb")).toBe("bb");
	});
});

// ==========================================================================
// detectConfigLoosening — parser + branch coverage of the pure detector
// ==========================================================================

describe("detectConfigLoosening — parsing + fail-open edges", () => {
	it("returns empty when beforeText is empty (new file)", () => {
		expect(
			detectConfigLoosening("tsconfig.json", "", `{ "compilerOptions": { "strict": false } }`),
		).toEqual([]);
	});

	it("returns empty when the proposed (after) text is unparseable", () => {
		// Can't parse the proposed file → defer to tsc/biome; fail open.
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": false`; // truncated, invalid
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("returns empty when the proposed (after) text is empty (safeJsonParse('') → null)", () => {
		// beforeText is non-empty so the new-file guard is passed; the empty
		// `after` must funnel through safeJsonParse's `!text` short-circuit and
		// fail open rather than throw.
		const before = `{ "compilerOptions": { "strict": true } }`;
		expect(detectConfigLoosening("tsconfig.json", before, "")).toEqual([]);
	});

	it("does not throw when compilerOptions is a non-object scalar", () => {
		// `get(before, "compilerOptions")` must early-return undefined when the
		// node isn't an object — exercises the typeof-guard inside get().
		const before = `{ "compilerOptions": "oops" }`;
		const after = `{ "compilerOptions": 42 }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("tolerates JSONC // line comments and trailing commas", () => {
		const before = `{
			// project strictness
			"compilerOptions": { "strict": true, }
		}`;
		const after = `{
			// project strictness
			"compilerOptions": { "strict": false, }
		}`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.map((f) => f.rule)).toContain("strict");
	});

	it("tolerates JSONC /* block */ comments", () => {
		const before = `{ /* strict on */ "compilerOptions": { "strictNullChecks": true } }`;
		const after = `{ /* strict off */ "compilerOptions": { "strictNullChecks": false } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after).length).toBe(1);
	});

	it("does not strip // text embedded inside a JSON string", () => {
		const parsed = safeJsonParse(`{ "message": "hello // keep this text" }`);
		expect(parsed).toEqual({ message: "hello // keep this text" });
	});

	it("removes a trailing comma even when no whitespace precedes the closer", () => {
		expect(safeJsonParse(`{ "compilerOptions": { "strict": true,}}`)).toEqual({
			compilerOptions: { strict: true },
		});
	});

	it("matches a monorepo-nested tsconfig path", () => {
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": false } }`;
		const findings = detectConfigLoosening("packages/api/tsconfig.json", before, after);
		expect(findings.map((f) => f.rule)).toContain("strict");
		expect(nonNull(findings[0]).file).toBe("packages/api/tsconfig.json");
	});

	it("matches tsconfig.build.json variant", () => {
		const before = `{ "compilerOptions": { "noImplicitReturns": true } }`;
		const after = `{ "compilerOptions": { "noImplicitReturns": false } }`;
		expect(detectConfigLoosening("tsconfig.build.json", before, after).length).toBe(1);
	});

	it("fails open (empty) for biome.json — detector not yet implemented", () => {
		const before = `{ "linter": { "enabled": true } }`;
		const after = `{ "linter": { "enabled": false } }`;
		expect(detectConfigLoosening("biome.json", before, after)).toEqual([]);
	});

	it("fails open (empty) for .eslintrc.json — detector not yet implemented", () => {
		const before = `{ "rules": { "no-console": "error" } }`;
		const after = `{ "rules": { "no-console": "off" } }`;
		expect(detectConfigLoosening(".eslintrc.json", before, after)).toEqual([]);
	});
});

describe("detectConfigLoosening — package.json semver + script edges", () => {
	it("does NOT flag engines.node being raised (>=18 → >=22)", () => {
		const before = `{ "engines": { "node": ">=18.0.0" } }`;
		const after = `{ "engines": { "node": ">=22.0.0" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("does NOT flag when engines.node is absent in both", () => {
		const before = `{ "name": "x" }`;
		const after = `{ "name": "y" }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("does NOT flag when an engines block exists but lacks a node key", () => {
		// parseSemverFloor(undefined) → 0 on both sides; no floor to compare.
		const before = `{ "engines": { "npm": ">=9" } }`;
		const after = `{ "engines": {} }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("does NOT flag when only a non-required script is removed", () => {
		const before = `{ "scripts": { "test": "vitest", "docs": "typedoc" } }`;
		const after = `{ "scripts": { "test": "vitest" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("does NOT flag when engines.node has no parseable number", () => {
		// parseSemverFloor returns 0 for a spec with no digits → no floor known.
		const before = `{ "engines": { "node": "latest" } }`;
		const after = `{ "engines": { "node": ">=18.0.0" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("flags every removed required script independently", () => {
		const before = `{ "scripts": { "test": "vitest", "typecheck": "tsc", "lint": "biome", "build": "tsup" } }`;
		const after = `{ "scripts": {} }`;
		const findings = detectConfigLoosening("package.json", before, after);
		const rules = findings.map((f) => f.rule).sort();
		expect(rules).toEqual(["scripts.build", "scripts.lint", "scripts.test", "scripts.typecheck"]);
	});

	it("returns empty when proposed package.json is invalid JSON (before/after null guard)", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ "engines": { "node": `; // unparseable
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("returns empty when the committed (before) package.json is itself invalid JSON", () => {
		// before parses to null while after is valid → detectPackageJsonLoosening
		// hits its `before === null` early return rather than dereferencing null.
		const before = `{ "engines": { "node": `; // unparseable HEAD baseline
		const after = `{ "engines": { "node": ">=22.0.0" }, "scripts": { "test": "vitest" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("emits a human-readable message naming the rule and the regression", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ "engines": { "node": ">=18.0.0" } }`;
		const [finding] = detectConfigLoosening("package.json", before, after);
		expect(nonNull(finding).message).toContain("22");
		expect(nonNull(finding).message).toContain("18");
		expect(nonNull(finding).before).toBe(">=22.0.0");
		expect(nonNull(finding).after).toBe(">=18.0.0");
	});

	it("does not flag equal Node floors", () => {
		const content = `{ "engines": { "node": ">=22.0.0" } }`;
		expect(detectConfigLoosening("package.json", content, content)).toEqual([]);
	});

	it("distinguishes a real two-digit floor drop from first-digit equality", () => {
		const findings = detectConfigLoosening(
			"package.json",
			`{ "engines": { "node": ">=19.0.0" } }`,
			`{ "engines": { "node": ">=18.0.0" } }`,
		);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).rule).toBe("engines.node");
	});

	it("reports removal as removal when the engines block disappears", () => {
		const [finding] = detectConfigLoosening(
			"package.json",
			`{ "engines": { "node": ">=22.0.0" } }`,
			`{ "name": "x" }`,
		);
		expect(nonNull(finding).after).toBeUndefined();
		expect(nonNull(finding).message).toContain("no longer declares a Node version floor");
	});

	it("handles a missing engines block on either side without throwing", () => {
		expect(() =>
			detectConfigLoosening(
				"package.json",
				`{ "name": "x" }`,
				`{ "engines": { "node": ">=18.0.0" } }`,
			),
		).not.toThrow();
		expect(
			detectConfigLoosening(
				"package.json",
				`{ "name": "x" }`,
				`{ "engines": { "node": ">=18.0.0" } }`,
			),
		).toEqual([]);
	});

	it("includes the script rule explanation in its finding", () => {
		const [finding] = detectConfigLoosening(
			"package.json",
			`{ "scripts": { "test": "vitest" } }`,
			`{ "scripts": {} }`,
		);
		expect(nonNull(finding).message).toContain("standard entry point");
	});
});

// ==========================================================================
// evaluateConfigLooseningForEvent — full event path (Write + Edit + git HEAD)
// ==========================================================================

describe("evaluateConfigLooseningForEvent — applicability gating", () => {
	it("returns null when the event carries no tool_input at all", () => {
		// `event.tool_input || {}` must tolerate an absent tool_input rather
		// than dereferencing undefined — exercises the `|| {}` fallback.
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			tool_name: "Write",
			timestamp: "2026-06-07T00:00:00Z",
		};
		expect(evaluateConfigLooseningForEvent(event)).toBeNull();
	});

	it("returns null when there is no file_path", () => {
		expect(evaluateConfigLooseningForEvent(makeEvent({ content: "{}" }))).toBeNull();
	});

	it("returns null for a non-config file_path", () => {
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: "src/lib/foo.ts", content: `{ "strict": false }` }),
		);
		expect(decision).toBeNull();
	});

	it("returns null for a config file with neither content nor old/new strings", () => {
		// e.g. a Read-shaped tool_input — nothing to reconstruct.
		expect(
			evaluateConfigLooseningForEvent(makeEvent({ file_path: "tsconfig.json" })),
		).toBeNull();
	});

	it("returns null when old_string is present but new_string is missing", () => {
		expect(
			evaluateConfigLooseningForEvent(
				makeEvent({ file_path: "tsconfig.json", old_string: '"strict": true' }),
			),
		).toBeNull();
	});
});

describe("evaluateConfigLooseningForEvent — Write tool against git HEAD", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("returns a `block` decision when a Write loosens strict relative to HEAD (tsconfig is a ratchet)", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		const proposed = `{ "compilerOptions": { "strict": false } }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: join(dir, "tsconfig.json"), content: proposed }, dir),
		);
		expect(decision).not.toBeNull();
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("config_loosening_gate");
		expect(decision?.severity).toBe("high");
		expect(decision?.category).toBe("config");
		expect(decision?.reason).toContain("strict");
		expect(decision?.reason).toContain("loosens TypeScript strictness");
		expect(decision?.reason).toContain("effectively flipped from true → false");
		expect(decision?.reason).toContain("INTERLINKED_DISABLE_BASELINE_GUARD=1");
	});

	it("blocks dropping `allowUnreachableCode: false` (inverted-polarity flag)", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true, "allowUnreachableCode": false } }`,
		);
		const proposed = `{ "compilerOptions": { "strict": true } }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: join(dir, "tsconfig.json"), content: proposed }, dir),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("allowUnreachableCode");
	});

	it("blocks removing noUnusedLocals", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true, "noUnusedLocals": true } }`,
		);
		const proposed = `{ "compilerOptions": { "strict": true } }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: join(dir, "tsconfig.json"), content: proposed }, dir),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("noUnusedLocals");
	});

	it("still ASKS (not blocks) for package.json loosening — only tsconfig is a ratchet", () => {
		dir = makeRepoWithCommittedFile(
			"package.json",
			`{ "engines": { "node": ">=22.0.0" } }`,
		);
		const proposed = `{ "engines": { "node": ">=18.0.0" } }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: join(dir, "package.json"), content: proposed }, dir),
		);
		expect(decision?.decision).toBe("ask");
	});

	it("aggregates multiple findings into one reason (engines + script removal)", () => {
		dir = makeRepoWithCommittedFile(
			"package.json",
			`{ "engines": { "node": ">=22.0.0" }, "scripts": { "test": "vitest" } }`,
		);
		const proposed = `{ "engines": { "node": ">=18.0.0" }, "scripts": {} }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: join(dir, "package.json"), content: proposed }, dir),
		);
		expect(decision?.decision).toBe("ask");
		expect(decision?.reason).toContain("[engines.node]");
		expect(decision?.reason).toContain("\n  [scripts.test]");
	});

	it("returns null when the Write does not loosen anything (tightening)", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": false } }`,
		);
		const proposed = `{ "compilerOptions": { "strict": true } }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: join(dir, "tsconfig.json"), content: proposed }, dir),
		);
		expect(decision).toBeNull();
	});

	it("returns null when the file's directory is not a git repo (rev-parse fails)", () => {
		// Plain temp dir, NO `git init` → `git -C <dir> rev-parse` exits non-zero
		// → readHeadVersion returns "" → detectConfigLoosening's empty-before
		// guard fails open. Exercises the rev-parse failure branch.
		dir = mkdtempSync(join(tmpdir(), "clg-nogit-"));
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					content: `{ "compilerOptions": { "strict": false } }`,
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("fails open when the file path resolves outside its own repo root", { timeout: 60_000 }, () => {
		// readHeadVersion guards against `relative(repoRoot, absFile)` producing a
		// `..`-prefixed path (a file that resolves outside the repo `git -C` found
		// for its dirname). The divergence is constructed with an EXPLICIT symlink
		// of our own so the condition exists on every platform: `git rev-parse`
		// resolves symlinks and reports the REAL repo root, while `path.resolve`
		// keeps the symlinked prefix, so `relative()` yields `..` and the gate
		// must fail open (null) — never an `ask` on a phantom baseline. The
		// previous version leaned on macOS's `/var → /private/var` tmpdir symlink
		// for the divergence; on Linux CI runners `/tmp` is real, the path
		// resolved INSIDE the repo, and the gate correctly fired `ask` on the
		// genuine strict→false loosening — a platform-conditional fixture
		// asserting unconditionally (finding 2026-06).
		const real = mkdtempSync(join(tmpdir(), "clg-symreal-"));
		dir = real;
		execSync("git init -q -b main", { cwd: real });
		execSync("git config user.email test@example.com", { cwd: real });
		execSync("git config user.name test", { cwd: real });
		writeFileSync(join(real, "tsconfig.json"), `{ "compilerOptions": { "strict": true } }`);
		execSync("git add tsconfig.json", { cwd: real });
		execSync('git commit -q -m "init"', { cwd: real });
		const linkParent = mkdtempSync(join(tmpdir(), "clg-symlink-"));
		try {
			const link = join(linkParent, "repo");
			symlinkSync(real, link, "dir");
			// Pass the path THROUGH the symlink as file_path. content loosens
			// strict, so a phantom-baseline bug would surface as a false `ask`;
			// correct behavior is null (the path resolves outside the repo root
			// git reported, so no valid HEAD baseline can be located).
			const decision = evaluateConfigLooseningForEvent(
				makeEvent(
					{
						file_path: join(link, "tsconfig.json"),
						content: `{ "compilerOptions": { "strict": false } }`,
					},
					link,
				),
			);
			expect(decision).toBeNull();
		} finally {
			rmSync(linkParent, { recursive: true, force: true });
		}
	});

	it("returns null when the config exists in a repo but was never committed (git show fails)", { timeout: 60_000 }, () => {
		// Repo with an empty initial commit; tsconfig.json is on disk but not in
		// HEAD → `git show HEAD:tsconfig.json` exits non-zero → readHeadVersion
		// returns "" → fails open. Exercises the show-status failure branch
		// distinct from the rev-parse failure above.
		const raw = mkdtempSync(join(tmpdir(), "clg-uncommitted-"));
		execSync("git init -q -b main", { cwd: raw });
		execSync("git config user.email test@example.com", { cwd: raw });
		execSync("git config user.name test", { cwd: raw });
		execSync('git commit -q --allow-empty -m "init"', { cwd: raw });
		dir = execSync("git rev-parse --show-toplevel", { cwd: raw, encoding: "utf-8" }).trim();
		writeFileSync(join(dir, "tsconfig.json"), `{ "compilerOptions": { "strict": true } }`);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					content: `{ "compilerOptions": { "strict": false } }`,
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("resolves a relative Write file_path against the ambient repo and fails open when uncommitted", () => {
		// A relative config path drives readHeadVersion down its
		// `resolve(file)` (non-absolute) branch. The test runner's cwd IS a git
		// repo, but this fixture basename is not committed at HEAD, so
		// `git show HEAD:<rel>` fails → empty baseline → fails open → null.
		// Deterministic regardless of the repo's real config contents.
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({
				file_path: "tsconfig.test-fixture.json",
				content: `{ "compilerOptions": { "strict": false } }`,
			}),
		);
		expect(decision).toBeNull();
	});

	it("accepts the `path` tool-input key as an alias for file_path", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strictNullChecks": true } }`,
		);
		const proposed = `{ "compilerOptions": { "strictNullChecks": false } }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ path: join(dir, "tsconfig.json"), content: proposed }, dir),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("strictNullChecks");
	});

	it("reads the exact committed content through the repository-relative path", () => {
		dir = makeRepoWithCommittedFile("tsconfig.json", `{ "compilerOptions": { "strict": true } }`);
		expect(readHeadVersion(join(dir, "tsconfig.json"))).toBe(
			`{ "compilerOptions": { "strict": true } }`,
		);
	});

	it("returns an empty baseline for a committed empty file", () => {
		dir = makeRepoWithCommittedFile("empty.json", "");
		expect(readHeadVersion(join(dir, "empty.json"))).toBe("");
	});
});

describe("evaluateConfigLooseningForEvent — Edit tool reconstruction path", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("reconstructs Edit content from disk and asks when it loosens HEAD", () => {
		// HEAD == disk == strict:true; the edit flips it to false.
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					old_string: '"strict": true',
					new_string: '"strict": false',
				},
				dir,
			),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("strict");
	});

	it("rejects a non-string old_string instead of reconstructing it", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					old_string: true,
					new_string: "false",
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("rejects a non-string new_string instead of reconstructing it", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					old_string: "true",
					new_string: false,
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("returns null when the Edit's old_string is not found on disk", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					old_string: '"noSuchKey": 1',
					new_string: '"noSuchKey": 2',
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	// test-contract: boundary — malformed Edit fields are rejected even when a non-string old_string would coerce to a matching disk substring
	it("does not reconstruct a loosening from a numeric old_string", () => {
		dir = makeRepoWithCommittedFile(
			"package.json",
			`{ "engines": { "node": ">=22.0.0" } }`,
		);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "package.json"),
					old_string: 22,
					new_string: "18",
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("returns null when the disk file does not exist (readDiskContent → null)", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		// Target a config basename that is NOT on disk in this repo.
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "biome.json"),
					old_string: '"strict": true',
					new_string: '"strict": false',
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("returns null when an Edit reconstructs but does not loosen (false→true)", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": false } }`,
		);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					old_string: '"strict": false',
					new_string: '"strict": true',
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("resolves a relative Edit file_path against process.cwd() when event.cwd is absent", () => {
		// No `cwd` on the event + a relative config path forces readDiskContent
		// down the `resolve(process.cwd(), file)` fallback. The test runner's cwd
		// is the repo root, whose package.json exists; a synthetic old_string that
		// is absent from it makes reconstruction return null → decision null.
		// This exercises the cwd-fallback branch without mutating process state.
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({
				file_path: "package.json",
				old_string: '"__interlinked_synthetic_absent_key__": "vendor-model-v6"',
				new_string: '"__interlinked_synthetic_absent_key__": "vendor-model-v7"',
			}),
		);
		expect(decision).toBeNull();
	});
});
