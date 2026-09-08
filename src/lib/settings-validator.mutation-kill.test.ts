// Mutation-survivor-kill companion for src/lib/settings-validator.ts
// (fleet-r3, pass1_w22).
//
// Targets the 53 status="survived" mutants recorded against this file in
// .interlinked/mutation-manifest.json. 34 are killed below with
// exact-observable assertions; 19 are suspected-equivalent (dead guards
// whose removal never changes an observable return value or file write —
// each case is either a defensive check made redundant by a sibling guard,
// or an out-of-bounds loop-index read that always yields `undefined` and so
// never matches `"("`/`")"`/`"string"`). See the structural argument for
// each at scratch/fleet-r3/receipts/src_lib_settings-validator.ts.jsonl.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	analyzeParenBalance,
	autoStripAllScopes,
	classifyRule,
	defaultSettingsPaths,
	findMalformedRulesIn,
	stripMalformedRulesAudited,
	suggestRuleFix,
	validateSettingsFile,
} from "./settings-validator.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sv-mk-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("analyzeParenBalance — firstBadCol tracking", () => {
	// test-contract: invariant — firstBadCol locks onto the FIRST over-close column; a second stray ")" must not overwrite it with the later column.
	it("keeps firstBadCol at the first offender across repeated over-closes", () => {
		expect(analyzeParenBalance("))")).toEqual({ depth: -2, firstBadCol: 0 });
	});

	// test-contract: invariant — the post-loop "missing close" fallback only fires when NO over-close was ever recorded; it must not clobber an already-set firstBadCol with rule.length.
	it("does not let the missing-close fallback overwrite an already-recorded over-close column", () => {
		expect(analyzeParenBalance(")((")).toEqual({ depth: 1, firstBadCol: 0 });
	});

	// test-contract: boundary — a fully balanced rule must report firstBadCol -1 (untouched), not rule.length.
	it("reports firstBadCol -1, not rule.length, for a balanced rule", () => {
		expect(analyzeParenBalance("Bash(grep *)").firstBadCol).toBe(-1);
	});
});

describe("suggestRuleFix — depth/firstBadCol boundaries", () => {
	// test-contract: boundary — a paren_imbalance rule that is actually already balanced (depth 0) must yield no fix, not an unchanged echo of the input.
	it("returns null for paren_imbalance when the rule is already balanced", () => {
		expect(suggestRuleFix("Bash(ok)", "paren_imbalance")).toBeNull();
	});

	// test-contract: boundary — when the sole offending ")" is the very first character, firstBadCol is 0 (a valid, found column) and the drop-fix must still fire.
	it("drops a lone leading over-close where firstBadCol is 0", () => {
		expect(suggestRuleFix(")", "paren_imbalance")).toBe("");
	});

	// test-contract: invariant — empty_rule has NO mechanical fix, even when the body looks shell-shaped; only reason missing_tool_prefix ever wraps.
	it("never wraps a shell-shaped body under reason empty_rule", () => {
		expect(suggestRuleFix("some cmd *", "empty_rule")).toBeNull();
	});

	// test-contract: boundary — a whitespace-only body under missing_tool_prefix must trim to empty and return null, not wrap the raw untrimmed whitespace.
	it("returns null for a whitespace-only body under missing_tool_prefix", () => {
		expect(suggestRuleFix("   ", "missing_tool_prefix")).toBeNull();
	});
});

describe("classifyRule", () => {
	// test-contract: boundary — a whitespace-only rule must classify as empty_rule via .trim(), not fall through to missing_tool_prefix.
	it("classifies a whitespace-only rule as empty_rule", () => {
		expect(classifyRule("   ")).toBe("empty_rule");
	});

	// test-contract: invariant — RULE_TOOL_PREFIX_RE is start-anchored; a tool-shaped substring appearing after a leading non-letter must not count as a valid prefix.
	it("requires the tool-prefix pattern to match at column 0, not anywhere in the string", () => {
		expect(classifyRule("1Bash(ls)")).toBe("missing_tool_prefix");
	});
});

describe("findMalformedRulesIn — guard boundaries", () => {
	// test-contract: boundary — a function has typeof "function", not "object"; even with an ad-hoc .permissions property attached (functions ARE real objects at runtime), the top-level type guard must reject it before that property is ever read.
	it("rejects a function value even when it carries an attached .permissions object", () => {
		function candidate(): void {}
		Object.assign(candidate, { permissions: { allow: ["Bash(broken"] } });
		expect(findMalformedRulesIn(candidate)).toEqual([]);
	});

	// test-contract: boundary — a plain object with no "permissions" key at all must short-circuit before any bucket is indexed.
	it("returns empty for a plain object missing the permissions key entirely", () => {
		expect(findMalformedRulesIn({})).toEqual([]);
	});

	// test-contract: boundary — permissions explicitly set to null must short-circuit rather than reach bucket indexing.
	it("returns empty when permissions is explicitly null", () => {
		expect(findMalformedRulesIn({ permissions: null })).toEqual([]);
	});

	// test-contract: boundary — permissions may itself be truthy yet non-object (typeof "function"); the object-shape guard must reject it even though its attached "allow" property IS a real array.
	it("rejects a truthy non-object permissions value that carries an array-shaped allow property", () => {
		function fakePerms(): void {}
		Object.assign(fakePerms, { allow: ["Bash(broken"] });
		expect(findMalformedRulesIn({ permissions: fakePerms })).toEqual([]);
	});

	// test-contract: boundary — a non-string list entry must be skipped before classifyRule ever sees it (classifyRule assumes a string and calls .trim() on it).
	it("skips a non-string rule entry instead of classifying it", () => {
		expect(findMalformedRulesIn({ permissions: { allow: [42] } })).toEqual([]);
	});
});

describe("defaultSettingsPaths — exact path contract", () => {
	// test-contract: public-api — the exact four-path contract: project settings.json, project settings.local.json, then the same two under homedir().
	it("returns the exact four paths in order", () => {
		expect(defaultSettingsPaths("/some/proj")).toEqual([
			join("/some/proj", ".claude", "settings.json"),
			join("/some/proj", ".claude", "settings.local.json"),
			join(homedir(), ".claude", "settings.json"),
			join(homedir(), ".claude", "settings.local.json"),
		]);
	});
});

describe("validateSettingsFile — parse-shape and skip boundaries", () => {
	// test-contract: boundary — JSON.parse("null") is a VALID parse (not a parseError); the cast-then-optional-chain read of .permissions on the resulting null must not throw.
	it("handles a top-level JSON null without throwing or setting parseError", () => {
		const path = join(dir, "settings.json");
		writeFileSync(path, "null");
		const v = validateSettingsFile(path);
		expect(v.malformed).toEqual([]);
		expect(v.totalRules).toBe(0);
		expect(v.parseError).toBeUndefined();
	});

	// test-contract: boundary — permissions explicitly null must be treated as absent, not indexed by bucket.
	it("treats an explicit permissions: null as absent", () => {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ permissions: null }));
		const v = validateSettingsFile(path);
		expect(v.malformed).toEqual([]);
		expect(v.totalRules).toBe(0);
	});

	// test-contract: boundary — a non-string rule entry must be skipped: never counted toward totalRules, never handed to classifyRule.
	it("skips a non-string rule entry without counting or classifying it", () => {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ permissions: { allow: [42] } }));
		const v = validateSettingsFile(path);
		expect(v.malformed).toEqual([]);
		expect(v.totalRules).toBe(0);
	});

	// test-contract: invariant — a missing file returns via the early exists-check and never reaches the try/catch, so parseError stays undefined (not an ENOENT message).
	it("leaves parseError undefined for a missing file", () => {
		const v = validateSettingsFile(join(dir, "does-not-exist.json"));
		expect(v.exists).toBe(false);
		expect(v.parseError).toBeUndefined();
	});
});

describe("stripMalformedRulesAudited — parse-shape and skip boundaries", () => {
	// test-contract: boundary — JSON.parse("null") is a valid parse; the cast-then-optional-chain read of .permissions on the resulting null must not throw.
	it("handles a top-level JSON null without throwing", () => {
		const path = join(dir, "settings.json");
		writeFileSync(path, "null");
		expect(stripMalformedRulesAudited(path)).toEqual({ stripped: 0, entries: [] });
	});

	// test-contract: boundary — a settings object with no permissions key at all must short-circuit before any bucket is indexed.
	it("no-ops when permissions is absent entirely", () => {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ hooks: {} }));
		expect(stripMalformedRulesAudited(path)).toEqual({ stripped: 0, entries: [] });
	});

	// test-contract: boundary — permissions explicitly null must short-circuit rather than reach bucket indexing.
	it("no-ops when permissions is explicitly null", () => {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ permissions: null }));
		expect(stripMalformedRulesAudited(path)).toEqual({ stripped: 0, entries: [] });
	});

	// test-contract: boundary — a non-string list entry must be preserved untouched, never handed to classifyRule (which assumes a string and calls .trim()).
	it("preserves a non-string rule entry untouched instead of classifying it", () => {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ permissions: { allow: [42] } }));
		const result = stripMalformedRulesAudited(path);
		expect(result).toEqual({ stripped: 0, entries: [] });
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
			permissions: { allow: [42] },
		});
	});
});

describe("autoStripAllScopes — audit log path is optional", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "autostrip-mk-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	// Asserts a lower bound, not an exact count: defaultSettingsPaths() also
	// scans the REAL homedir() settings files (same hazard the sibling
	// settings-validator.test.ts documents), so this only proves our own
	// injected project-scope entry survived without a crash — it does not
	// assume the host's ~/.claude files are clean.
	// test-contract: invariant — when malformed rules ARE found but no auditLogPath is passed, the function must complete without ever calling appendStripAuditLog (which would crash on dirname(undefined) once entries is non-empty).
	it("completes without an audit log when auditLogPath is omitted, even with strips to report", () => {
		mkdirSync(join(projectRoot, ".claude"), { recursive: true });
		writeFileSync(
			join(projectRoot, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(broken"] } }),
		);
		const result = autoStripAllScopes(projectRoot);
		expect(result.totalStripped).toBeGreaterThanOrEqual(1);
		expect(result.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ rule: "Bash(broken" })]),
		);
	});
});
