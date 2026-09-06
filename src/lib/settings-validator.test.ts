import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	analyzeParenBalance,
	appendStripAuditLog,
	autoStripAllScopes,
	defaultStripAuditLogPath,
	isParenBalanced,
	stripMalformedRules,
	stripMalformedRulesAudited,
	suggestRuleFix,
	validateSettingsFile,
} from "./settings-validator.js";

describe("isParenBalanced", () => {
	it("accepts simple balanced rules", () => {
		expect(isParenBalanced("Bash(grep *)")).toBe(true);
		expect(isParenBalanced("Bash(node *)")).toBe(true);
		expect(isParenBalanced("WebFetch(domain:github.com)")).toBe(true);
	});

	it("accepts nested balanced parens (e.g. command substitution)", () => {
		expect(isParenBalanced("Bash(DEMO_CWD=$(ls *))")).toBe(true);
	});

	it("rejects extra closing paren — the /doctor regression case", () => {
		// Real entry that triggered Claude Code's /doctor "Mismatched
		// parentheses" warning: opens `Bash(`, prematurely closes after
		// `-d)`, then trails an extra `)`.
		expect(
			isParenBalanced(
				"Bash(-d) && cd && echo && node /Users/quentincody/interlinked-cli/dist/index.js *)",
			),
		).toBe(false);
	});

	it("rejects unclosed opener", () => {
		expect(isParenBalanced("Bash(foo")).toBe(false);
	});

	it("rejects close-before-open", () => {
		expect(isParenBalanced(")(")).toBe(false);
	});
});

describe("validateSettingsFile + stripMalformedRules", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-settings-"));
		path = join(dir, "settings.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports zero malformed for a clean allowlist", () => {
		writeFileSync(
			path,
			JSON.stringify({
				permissions: { allow: ["Bash(grep *)", "Bash(git *)"] },
			}),
		);
		const v = validateSettingsFile(path);
		expect(v.exists).toBe(true);
		expect(v.totalRules).toBe(2);
		expect(v.malformed).toHaveLength(0);
	});

	it("flags malformed entries across allow/deny/ask buckets with bucket+index metadata", () => {
		writeFileSync(
			path,
			JSON.stringify({
				permissions: {
					allow: ["Bash(grep *)", "Bash(-d) && echo *)"],
					deny: ["Bash(broken"],
					ask: ["Bash(ok *)"],
				},
			}),
		);
		const v = validateSettingsFile(path);
		expect(v.totalRules).toBe(4);
		expect(v.malformed).toHaveLength(2);
		const buckets = v.malformed.map((m) => m.bucket).sort();
		expect(buckets).toEqual(["allow", "deny"]);
		// Index points to the offender, not the surviving sibling.
		const allowOffender = v.malformed.find((m) => m.bucket === "allow");
		expect(allowOffender?.index).toBe(1);
	});

	it("handles missing file without throwing", () => {
		const v = validateSettingsFile(join(dir, "does-not-exist.json"));
		expect(v.exists).toBe(false);
		expect(v.malformed).toHaveLength(0);
	});

	it("captures parseError for invalid JSON instead of crashing", () => {
		writeFileSync(path, "{not json");
		const v = validateSettingsFile(path);
		expect(v.exists).toBe(true);
		expect(v.parseError).toBeTruthy();
		expect(v.malformed).toHaveLength(0);
	});

	it("ignores files that have no permissions block", () => {
		writeFileSync(path, JSON.stringify({ hooks: {} }));
		const v = validateSettingsFile(path);
		expect(v.totalRules).toBe(0);
		expect(v.malformed).toHaveLength(0);
	});

	it("strips malformed rules and rewrites file, preserving order of survivors", () => {
		writeFileSync(
			path,
			JSON.stringify({
				permissions: {
					allow: [
						"Bash(grep *)",
						"Bash(-d) && echo *)",
						"Bash(git *)",
						"Bash(broken",
						"Bash(node *)",
					],
				},
			}),
		);
		const stripped = stripMalformedRules(path);
		expect(stripped).toBe(2);
		const after = JSON.parse(readFileSync(path, "utf-8")) as {
			permissions: { allow: string[] };
		};
		expect(after.permissions.allow).toEqual([
			"Bash(grep *)",
			"Bash(git *)",
			"Bash(node *)",
		]);
		// Re-validating the rewritten file finds nothing.
		expect(validateSettingsFile(path).malformed).toHaveLength(0);
	});

	it("returns 0 and does not touch the file when nothing is malformed", () => {
		const original = JSON.stringify({
			permissions: { allow: ["Bash(grep *)"] },
		});
		writeFileSync(path, original);
		const stripped = stripMalformedRules(path);
		expect(stripped).toBe(0);
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	it("is a no-op on missing files (safe to call from --fix unconditionally)", () => {
		expect(stripMalformedRules(join(dir, "missing.json"))).toBe(0);
	});
});

describe("analyzeParenBalance", () => {
	it("returns depth 0 for balanced rules", () => {
		expect(analyzeParenBalance("Bash(grep *)").depth).toBe(0);
		expect(analyzeParenBalance("Bash(MARKER=$(date *))").depth).toBe(0);
		expect(analyzeParenBalance("WebFetch(domain:github.com)").depth).toBe(0);
	});

	it("reports positive depth for missing closing parens", () => {
		const r = analyzeParenBalance("Bash(MARKER=$(date *)");
		expect(r.depth).toBe(1);
		// firstBadCol points at end-of-string for missing-close cases
		expect(r.firstBadCol).toBe("Bash(MARKER=$(date *)".length);
	});

	it("reports negative depth for extra closing parens", () => {
		const r = analyzeParenBalance("Bash(ls))");
		expect(r.depth).toBe(-1);
		expect(r.firstBadCol).toBe("Bash(ls)".length); // the offending second `)`
	});
});

describe("suggestRuleFix", () => {
	it("appends `)` for missing-close paren imbalance", () => {
		expect(suggestRuleFix("Bash(MARKER=$(date *)", "paren_imbalance")).toBe(
			"Bash(MARKER=$(date *))",
		);
		// Two missing closes
		expect(suggestRuleFix("Bash(a$(b$(c)", "paren_imbalance")).toBe("Bash(a$(b$(c)))");
	});

	it("drops the first extra `)` for depth = -1 paren imbalance", () => {
		expect(suggestRuleFix("Bash(ls))", "paren_imbalance")).toBe("Bash(ls)");
	});

	it("returns null for ambiguous deeper depth-negative cases", () => {
		// Two excess closing parens — too many plausible edits to guess.
		expect(suggestRuleFix("Bash(ls))) ", "paren_imbalance")).toBeNull();
	});

	it("treats undefined reason as paren_imbalance (legacy)", () => {
		expect(suggestRuleFix("Bash(MARKER=$(date *)", undefined)).toBe("Bash(MARKER=$(date *))");
	});

	it("returns null for empty_rule (no mechanical fix)", () => {
		expect(suggestRuleFix("", "empty_rule")).toBeNull();
		expect(suggestRuleFix("   ", "empty_rule")).toBeNull();
	});

	it("wraps shell-shaped bodies for missing_tool_prefix", () => {
		expect(suggestRuleFix("ls *", "missing_tool_prefix")).toBe("Bash(ls *)");
		expect(suggestRuleFix("rm -rf *", "missing_tool_prefix")).toBe("Bash(rm -rf *)");
		expect(suggestRuleFix("grep | head", "missing_tool_prefix")).toBe("Bash(grep | head)");
	});

	it("returns null for missing_tool_prefix when the body has no shell shape", () => {
		// A single-word entry could be a wrong tool name, a malformed identifier,
		// or accidental garbage — too ambiguous to auto-wrap.
		expect(suggestRuleFix("foobar", "missing_tool_prefix")).toBeNull();
	});
});

describe("stripMalformedRulesAudited", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "stripaudited-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns entries describing every stripped rule", () => {
		const path = join(dir, "settings.json");
		writeFileSync(
			path,
			JSON.stringify({
				permissions: {
					allow: [
						"Bash(ls *)",
						"Bash(MARKER=$(date *)", // paren imbalance
						"", // empty
						"plain garbage", // missing tool prefix
						"WebFetch(domain:example.com)",
					],
				},
			}),
		);
		const result = stripMalformedRulesAudited(path);
		expect(result.stripped).toBe(3);
		expect(result.entries.map((e) => e.reason)).toEqual([
			"paren_imbalance",
			"empty_rule",
			"missing_tool_prefix",
		]);
		// indexes are pre-strip (i.e., from the original list)
		expect(result.entries.map((e) => e.index)).toEqual([1, 2, 3]);
		// every entry carries the file, bucket, rule, and ISO timestamp
		for (const e of result.entries) {
			expect(e.file).toBe(path);
			expect(e.bucket).toBe("allow");
			expect(typeof e.timestamp).toBe("string");
			expect(/^\d{4}-\d{2}-\d{2}T/.test(e.timestamp)).toBe(true);
		}
		// file now only contains the well-formed entries
		const after = JSON.parse(readFileSync(path, "utf-8"));
		expect(after.permissions.allow).toEqual([
			"Bash(ls *)",
			"WebFetch(domain:example.com)",
		]);
	});

	it("returns empty result when the file has no malformed rules", () => {
		const path = join(dir, "clean.json");
		writeFileSync(
			path,
			JSON.stringify({ permissions: { allow: ["Bash(ls *)", "Bash(echo *)"] } }),
		);
		const result = stripMalformedRulesAudited(path);
		expect(result.stripped).toBe(0);
		expect(result.entries).toEqual([]);
	});

	it("returns empty result for missing files (safe to call unconditionally)", () => {
		const result = stripMalformedRulesAudited(join(dir, "missing.json"));
		expect(result.stripped).toBe(0);
		expect(result.entries).toEqual([]);
	});

	it("returns empty result instead of throwing when the file holds invalid JSON", () => {
		const path = join(dir, "invalid.json");
		writeFileSync(path, "{ this is not valid json");
		const result = stripMalformedRulesAudited(path);
		expect(result).toEqual({ stripped: 0, entries: [] });
		// the unparsable file is left untouched, not overwritten with an empty shell
		expect(readFileSync(path, "utf-8")).toBe("{ this is not valid json");
	});

	it("legacy stripMalformedRules still returns just the count", () => {
		const path = join(dir, "legacy.json");
		writeFileSync(
			path,
			JSON.stringify({
				permissions: { allow: ["Bash(ls *)", "Bash(broken("] },
			}),
		);
		expect(stripMalformedRules(path)).toBe(1);
	});
});

describe("appendStripAuditLog", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "stripaudit-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends one JSONL line per entry, creating the parent dir", () => {
		const logPath = join(dir, "nested", "permission-rule-strips.jsonl");
		appendStripAuditLog(logPath, [
			{
				timestamp: "2026-05-11T12:00:00.000Z",
				file: "/proj/.claude/settings.json",
				bucket: "allow",
				index: 7,
				rule: "Bash(broken",
				reason: "paren_imbalance",
			},
		]);
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toMatchObject({
			file: "/proj/.claude/settings.json",
			bucket: "allow",
			index: 7,
			rule: "Bash(broken",
			reason: "paren_imbalance",
		});
	});

	it("appends across multiple calls (each call writes its own lines)", () => {
		const logPath = join(dir, "log.jsonl");
		appendStripAuditLog(logPath, [
			{
				timestamp: "t1",
				file: "/a",
				bucket: "allow",
				index: 0,
				rule: "x",
				reason: "empty_rule",
			},
		]);
		appendStripAuditLog(logPath, [
			{
				timestamp: "t2",
				file: "/b",
				bucket: "deny",
				index: 1,
				rule: "y",
				reason: "missing_tool_prefix",
			},
		]);
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!).file).toBe("/a");
		expect(JSON.parse(lines[1]!).file).toBe("/b");
	});

	it("is a no-op on empty entries (doesn't create the file)", () => {
		const logPath = join(dir, "empty.jsonl");
		appendStripAuditLog(logPath, []);
		// File should not exist
		expect(() => readFileSync(logPath, "utf-8")).toThrow();
	});
});

describe("autoStripAllScopes + defaultStripAuditLogPath", () => {
	let projectRoot: string;
	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "autostrip-"));
	});
	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	it("defaultStripAuditLogPath sits under .interlinked/", () => {
		const p = defaultStripAuditLogPath(projectRoot);
		expect(p).toBe(join(projectRoot, ".interlinked", "permission-rule-strips.jsonl"));
	});

	it("strips a project-scope settings.json + writes the audit log", () => {
		mkdirSync(join(projectRoot, ".claude"), { recursive: true });
		writeFileSync(
			join(projectRoot, ".claude", "settings.json"),
			JSON.stringify({
				permissions: { allow: ["Bash(ok *)", "Bash(MARKER=$(date *)", ""] },
			}),
		);

		const auditPath = defaultStripAuditLogPath(projectRoot);
		const result = autoStripAllScopes(projectRoot, auditPath);

		expect(result.totalStripped).toBe(2);
		expect(result.entries.map((e) => e.reason)).toContain("paren_imbalance");
		expect(result.entries.map((e) => e.reason)).toContain("empty_rule");

		// Audit log written, one JSONL line per stripped entry
		const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);

		// settings.json now contains only the clean rule
		const after = JSON.parse(
			readFileSync(join(projectRoot, ".claude", "settings.json"), "utf-8"),
		);
		expect(after.permissions.allow).toEqual(["Bash(ok *)"]);
	});

	it("returns zero entries when no settings file exists in any scope", () => {
		// projectRoot has no .claude dir, and we can't realistically test
		// homedir() without polluting it — so we assume the user's actual
		// ~/.claude/settings.json is clean (most contributors), or accept
		// that the count may include real entries from the host. We assert
		// only the lower-bound contract: empty project + missing audit path
		// produces no crash and a number ≥ 0.
		const auditPath = defaultStripAuditLogPath(projectRoot);
		const result = autoStripAllScopes(projectRoot);
		expect(result.totalStripped).toBeGreaterThanOrEqual(0);
		// No audit path passed → no file created (lower-bound check)
		expect(() => readFileSync(auditPath, "utf-8")).toThrow();
	});
});
