import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import {
	loadGraphForFile,
	parseGraphFile,
	shardPathFor,
} from "../supermodel-graph.js";
import type { GuardRulesConfig, SessionTrajectory } from "../types.js";
import { makeEvent, makeSession } from "./fixtures/evaluator.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(HERE, "fixtures", "supermodel");

function fixtureContent(name: string): string {
	return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

describe("shardPathFor", () => {
	it("inserts .graph before standard extensions", () => {
		expect(shardPathFor("src/Foo.tsx")).toBe("src/Foo.graph.tsx");
		expect(shardPathFor("src/lib/util.ts")).toBe("src/lib/util.graph.ts");
		expect(shardPathFor("internal/api/client.go")).toBe(
			"internal/api/client.graph.go",
		);
		expect(shardPathFor("scripts/build.py")).toBe("scripts/build.graph.py");
	});

	it("appends .graph to extensionless paths", () => {
		expect(shardPathFor("Makefile")).toBe("Makefile.graph");
	});
});

describe("parseGraphFile", () => {
	it("parses the HIGH-risk fixture into all three sections", () => {
		const graph = parseGraphFile(
			fixtureContent("high-risk.graph.ts"),
			"high-risk.ts",
			"high-risk.graph.ts",
		);
		expect(graph).not.toBeNull();
		expect(graph!.impact).toEqual({
			risk: "HIGH",
			domains: ["API", "Database", "Auth", "Notifications"],
			direct: 8,
			transitive: 50,
			affects: [
				"src/api/users.ts",
				"src/api/posts.ts",
				"src/api/comments.ts",
				"src/api/admin.ts",
				"src/api/auth.ts",
				"src/api/billing.ts",
				"src/api/profile.ts",
				"src/api/settings.ts",
			],
		});
		expect(graph!.deps).toEqual({
			imports: ["src/lib/util.ts", "src/lib/db.ts"],
			importedBy: [
				"src/api/users.ts",
				"src/api/posts.ts",
				"src/api/comments.ts",
			],
		});
		expect(graph!.calls).not.toBeNull();
		expect(graph!.calls!.callers).toHaveLength(2);
		expect(graph!.calls!.callers[0]).toEqual({
			fn: "process",
			caller: "handle",
			file: "src/api/users.ts",
			line: 42,
		});
		expect(graph!.calls!.callees).toHaveLength(1);
		expect(graph!.calls!.callees[0]).toEqual({
			fn: "process",
			callee: "fetchData",
			file: "src/lib/db.ts",
			line: 18,
		});
	});

	it("parses the MEDIUM-risk fixture", () => {
		const graph = parseGraphFile(
			fixtureContent("medium-risk.graph.ts"),
			"medium-risk.ts",
			"medium-risk.graph.ts",
		);
		expect(graph?.impact).toEqual({
			risk: "MEDIUM",
			domains: ["UI", "Forms"],
			direct: 3,
			transitive: 8,
			affects: [
				"src/components/Form.tsx",
				"src/components/SignupForm.tsx",
				"src/components/LoginForm.tsx",
			],
		});
	});

	it("parses the LOW-risk fixture", () => {
		const graph = parseGraphFile(
			fixtureContent("low-risk.graph.ts"),
			"low-risk.ts",
			"low-risk.graph.ts",
		);
		expect(graph?.impact).toEqual({
			risk: "LOW",
			domains: ["Internal"],
			direct: 1,
			transitive: 1,
			affects: ["src/lib/util.ts"],
		});
	});

	it("treats absent `domains` line as empty array (Supermodel omits when empty)", () => {
		const graph = parseGraphFile(
			fixtureContent("no-domains.graph.ts"),
			"no-domains.ts",
			"no-domains.graph.ts",
		);
		expect(graph?.impact).toEqual({
			risk: "LOW",
			domains: [],
			direct: 2,
			transitive: 3,
			affects: ["src/lib/a.ts", "src/lib/b.ts"],
		});
	});

	it("treats absent `affects` line as empty array (Supermodel omits when direct === 0)", () => {
		const graph = parseGraphFile(
			fixtureContent("no-affects.graph.ts"),
			"no-affects.ts",
			"no-affects.graph.ts",
		);
		expect(graph?.impact).toEqual({
			risk: "HIGH",
			domains: ["A", "B", "C"],
			direct: 0,
			transitive: 30,
			affects: [],
		});
	});

	it("handles both `domains` and `affects` omitted simultaneously", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [impact]",
			"// risk        LOW",
			"// direct      0",
			"// transitive  0",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact).toEqual({
			risk: "LOW",
			domains: [],
			direct: 0,
			transitive: 0,
			affects: [],
		});
	});

	it("returns null on empty content", () => {
		expect(parseGraphFile("", "x.ts", "x.graph.ts")).toBeNull();
		expect(parseGraphFile("   \n  \n", "x.ts", "x.graph.ts")).toBeNull();
	});

	it("returns a graph with all-null sections when only the header is present", () => {
		const content = "// @generated supermodel-shard — do not edit\n";
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph).not.toBeNull();
		expect(graph!.impact).toBeNull();
		expect(graph!.calls).toBeNull();
		expect(graph!.deps).toBeNull();
	});

	it("parses [impact]-only shard with other sections null", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [impact]",
			"// risk        HIGH",
			"// direct      5",
			"// transitive  25",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact?.risk).toBe("HIGH");
		expect(graph?.calls).toBeNull();
		expect(graph?.deps).toBeNull();
	});

	it("parses Python-style `#`-prefixed shards", () => {
		const graph = parseGraphFile(
			fixtureContent("python.graph.py"),
			"python.py",
			"python.graph.py",
		);
		expect(graph?.impact?.risk).toBe("MEDIUM");
		expect(graph?.impact?.domains).toEqual(["CLI", "Util"]);
		expect(graph?.impact?.affects).toEqual([
			"tests/test_main.py",
			"tests/test_util.py",
		]);
		expect(graph?.deps?.imports).toEqual(["src/util.py"]);
	});

	it("skips Go `//go:build ignore` + `package ignore` preamble", () => {
		const graph = parseGraphFile(
			fixtureContent("go.graph.go"),
			"handler.go",
			"handler.graph.go",
		);
		expect(graph?.impact?.risk).toBe("MEDIUM");
		expect(graph?.impact?.domains).toEqual([
			"CLIInfrastructure",
			"SupermodelAPI",
		]);
		expect(graph?.calls?.callers).toHaveLength(1);
		expect(graph?.calls?.callees).toHaveLength(2);
		expect(graph?.deps?.imports).toEqual([
			"internal/api/client.go",
			"internal/cache/cache.go",
		]);
	});

	it("nulls only the [impact] section when malformed; other sections still parse", () => {
		const graph = parseGraphFile(
			fixtureContent("malformed-impact.graph.ts"),
			"malformed.ts",
			"malformed.graph.ts",
		);
		expect(graph).not.toBeNull();
		expect(graph!.impact).toBeNull();
		expect(graph!.deps).toEqual({
			imports: ["src/util.ts"],
			importedBy: ["src/main.ts"],
		});
	});

	it("nulls [impact] when `direct` is non-numeric, leaves `[deps]` intact", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [deps]",
			"// imports     a.ts",
			"// [impact]",
			"// risk        HIGH",
			"// direct      banana",
			"// transitive  3",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact).toBeNull();
		expect(graph?.deps).toEqual({ imports: ["a.ts"], importedBy: [] });
	});

	it("ignores unknown section names without breaking other sections", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [futuristic]",
			"// quantumness  high",
			"// [impact]",
			"// risk        MEDIUM",
			"// direct      2",
			"// transitive  6",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact?.risk).toBe("MEDIUM");
	});

	it("ignores stray non-comment lines in the body", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"console.log('rogue');",
			"// [impact]",
			"// risk        LOW",
			"// direct      1",
			"// transitive  1",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact?.risk).toBe("LOW");
	});

	it("returns null when no comment prefix can be detected", () => {
		const content = "this is plain text\nwithout any shard structure";
		expect(parseGraphFile(content, "x.ts", "x.graph.ts")).toBeNull();
	});

	it("nulls [impact] when `transitive` is non-numeric, leaves other fields intact", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [impact]",
			"// risk        HIGH",
			"// direct      3",
			"// transitive  banana",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact).toBeNull();
	});

	it("treats a `domains` key with no value as empty (falsy-value branch)", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [impact]",
			"// risk        LOW",
			"// domains",
			"// direct      1",
			"// transitive  1",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact).toEqual({
			risk: "LOW",
			domains: [],
			direct: 1,
			transitive: 1,
			affects: [],
		});
	});

	it("treats an `affects` key with no value as empty (falsy-value branch)", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [impact]",
			"// risk        LOW",
			"// direct      0",
			"// transitive  0",
			"// affects",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact).toEqual({
			risk: "LOW",
			domains: [],
			direct: 0,
			transitive: 0,
			affects: [],
		});
	});

	it("skips a deps line whose key has no value, and an unrecognized key", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [deps]",
			"// imports",
			"// unknown-key   whatever.ts",
			"// imports     src/real.ts",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.deps).toEqual({ imports: ["src/real.ts"], importedBy: [] });
	});

	it("parses every [calls] rest-token shape in one shard", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [calls]",
			"// not an arrow line at all",
			"// runA ← callerOnly",
			"// runB ← callerB    file.ts:abc",
			"// runC ← callerC    ?",
			"// runD ← First Last",
			"//  ← lonelyCaller",
			"// runE → calleeE    src/e.ts:7",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.calls).toEqual({
			callers: [
				{ fn: "runA", caller: "callerOnly", file: "", line: 0 },
				{ fn: "runB", caller: "callerB    file.ts:abc", file: "", line: 0 },
				{ fn: "runC", caller: "callerC", file: "", line: 0 },
				{ fn: "runD", caller: "First Last", file: "", line: 0 },
			],
			callees: [{ fn: "runE", callee: "calleeE", file: "src/e.ts", line: 7 }],
		});
	});

	it("preserves multi-token domain lists (regression: split tail join)", () => {
		const content = [
			"// @generated supermodel-shard — do not edit",
			"// [impact]",
			"// risk        HIGH",
			"// domains     A · B · C · D · E",
			"// direct      1",
			"// transitive  30",
			"// affects     foo.ts",
		].join("\n");
		const graph = parseGraphFile(content, "x.ts", "x.graph.ts");
		expect(graph?.impact?.domains).toEqual(["A", "B", "C", "D", "E"]);
	});
});

describe("loadGraphForFile", () => {
	it("loads via absolute source path", () => {
		const sourcePath = join(FIXTURES_DIR, "high-risk.ts");
		const graph = loadGraphForFile(sourcePath);
		expect(graph).not.toBeNull();
		expect(graph!.impact?.risk).toBe("HIGH");
	});

	it("loads via relative source path with cwd", () => {
		const graph = loadGraphForFile("medium-risk.ts", FIXTURES_DIR);
		expect(graph?.impact?.risk).toBe("MEDIUM");
	});

	it("returns null when relative path is supplied without cwd", () => {
		expect(loadGraphForFile("medium-risk.ts")).toBeNull();
	});

	it("returns null when the shard file is missing", () => {
		const sourcePath = join(FIXTURES_DIR, "does-not-exist.ts");
		expect(loadGraphForFile(sourcePath)).toBeNull();
	});

	it("returns null when source path resolves outside cwd (traversal guard)", () => {
		expect(loadGraphForFile("../../../etc/passwd", FIXTURES_DIR)).toBeNull();
	});

	it("returns null when the shard exceeds the 1 MB cap", () => {
		const dir = mkdtempSync(join(tmpdir(), "supermodel-bigshard-"));
		try {
			const shard = join(dir, "huge.graph.ts");
			const header = "// @generated supermodel-shard — do not edit\n";
			const padding = "// padding line that pushes the size over 1 MB\n";
			const padded = header + padding.repeat(25_000);
			writeFileSync(shard, padded);
			expect(padded.length).toBeGreaterThan(1024 * 1024);
			expect(loadGraphForFile(join(dir, "huge.ts"), dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null when the source path is empty", () => {
		expect(loadGraphForFile("", FIXTURES_DIR)).toBeNull();
		expect(loadGraphForFile("   ", FIXTURES_DIR)).toBeNull();
	});

	it("accepts a cwd that already ends with the path separator", () => {
		const cwdWithSep = FIXTURES_DIR.endsWith(sep) ? FIXTURES_DIR : FIXTURES_DIR + sep;
		const graph = loadGraphForFile("medium-risk.ts", cwdWithSep);
		expect(graph?.impact?.risk).toBe("MEDIUM");
	});

	it("returns null when the shard path exists but is a directory, not a file", () => {
		const dir = mkdtempSync(join(tmpdir(), "supermodel-dirshard-"));
		try {
			// The shard path Supermodel would use for `x.ts` is `x.graph.ts` —
			// create it as a directory so `stats.isFile()` is false.
			mkdirSync(join(dir, "x.graph.ts"), { recursive: true });
			expect(loadGraphForFile(join(dir, "x.ts"))).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null on an I/O error reading an unreadable shard file", () => {
		const dir = mkdtempSync(join(tmpdir(), "supermodel-noperm-"));
		const shard = join(dir, "x.graph.ts");
		writeFileSync(shard, "// @generated supermodel-shard — do not edit\n");
		try {
			chmodSync(shard, 0o000);
			expect(loadGraphForFile(join(dir, "x.ts"))).toBeNull();
		} finally {
			chmodSync(shard, 0o644);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("evaluatePreToolUse — Supermodel graph awareness", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	beforeEach(() => {
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	function findGraphWarning(warnings: string[] | undefined): string | undefined {
		return warnings?.find((w) => w.startsWith("[interlinked:supermodel-graph]"));
	}

	function findAllGraphWarnings(warnings: string[] | undefined): string[] {
		return warnings?.filter((w) => w.startsWith("[interlinked:supermodel-graph]")) ?? [];
	}

	it("emits HIGH-risk warning with relative path, dependent-file count, domains, and Affects clause", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: {
				file_path: join(FIXTURES_DIR, "high-risk.ts"),
				content: "// stub",
			},
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const warning = findGraphWarning(decision.warnings);
		expect(warning).toBeDefined();
		expect(warning).toContain("high-risk.ts:");
		expect(warning).toContain("HIGH-risk edit per .graph shard");
		expect(warning).toContain("8 dependent file(s)");
		expect(warning).toContain("50 transitive");
		expect(warning).toContain(
			"across domains API · Database · Auth · Notifications",
		);
		expect(warning).toContain("Affects: src/api/users.ts");
		expect(warning).toContain("Confirm this is intentional");
	});

	it("emits terse MEDIUM warning with relative path", () => {
		const event = makeEvent({
			tool_name: "Edit",
			tool_input: {
				file_path: "medium-risk.ts",
				old_string: "a",
				new_string: "b",
			},
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const warning = findGraphWarning(decision.warnings);
		expect(warning).toBeDefined();
		expect(warning).toContain("medium-risk.ts:");
		expect(warning).toContain("3 dependent file(s)");
		expect(warning).toContain("across UI · Forms");
		expect(warning).toContain("Affects: src/components/Form.tsx");
		expect(warning).not.toContain("HIGH-risk");
		expect(warning).not.toContain("Confirm this is intentional");
	});

	it("is silent on LOW-risk edits", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: {
				file_path: "low-risk.ts",
				content: "// stub",
			},
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(findGraphWarning(decision.warnings)).toBeUndefined();
	});

	it("omits the `across domains` clause cleanly when domains list is empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "supermodel-nodom-"));
		try {
			const shard = join(dir, "x.graph.ts");
			writeFileSync(
				shard,
				[
					"// @generated supermodel-shard — do not edit",
					"// [impact]",
					"// risk        HIGH",
					"// direct      4",
					"// transitive  30",
					"// affects     a.ts · b.ts · c.ts · d.ts",
				].join("\n"),
			);
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "x.ts", content: "// stub" },
				cwd: dir,
			});
			const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
			const warning = findGraphWarning(decision.warnings);
			expect(warning).toBeDefined();
			expect(warning).not.toContain("across domains");
			expect(warning).not.toContain(" across .");
			expect(warning).toContain("30 transitive.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("omits the `Affects:` clause cleanly when direct === 0 / affects empty", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { file_path: "no-affects.ts", content: "// stub" },
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const warning = findGraphWarning(decision.warnings);
		expect(warning).toBeDefined();
		expect(warning).not.toContain("Affects:");
		expect(warning).toContain("HIGH-risk edit");
	});

	it("does not warn when no shard file is present", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { file_path: "no-such-file.ts", content: "// stub" },
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(findGraphWarning(decision.warnings)).toBeUndefined();
	});

	it("resolves a relative file_path against event.cwd", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { file_path: "high-risk.ts", content: "// stub" },
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(findGraphWarning(decision.warnings)).toBeDefined();
	});

	it("emits one warning per touched file for multi-file Codex apply_patch", () => {
		const event = makeEvent({
			tool_name: "apply_patch",
			tool_input: {
				command: [
					"*** Begin Patch",
					"*** Update File: high-risk.ts",
					"@@",
					" foo",
					"*** Update File: medium-risk.ts",
					"@@",
					" bar",
					"*** Update File: low-risk.ts",
					"@@",
					" baz",
					"*** End Patch",
				].join("\n"),
			},
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const graphWarnings = findAllGraphWarnings(decision.warnings);
		expect(graphWarnings).toHaveLength(3); // high-risk: impact + calls; medium-risk: impact; low-risk: silent
		expect(graphWarnings.find((w) => w.includes("high-risk.ts:"))).toBeDefined();
		expect(graphWarnings.find((w) => w.includes("medium-risk.ts:"))).toBeDefined();
		expect(graphWarnings.find((w) => w.includes("low-risk.ts:"))).toBeUndefined();
	});

	it.each([
		["patch", "patch"],
		["content", "content"],
		["_raw_patch", "_raw_patch"],
	])(
		"surfaces graph warnings for apply_patch payloads delivered under tool_input.%s",
		(_label: string, field: string) => {
			const event = makeEvent({
				tool_name: "apply_patch",
				tool_input: {
					[field]: [
						"*** Begin Patch",
						"*** Update File: high-risk.ts",
						"@@",
						" foo",
						"*** End Patch",
					].join("\n"),
				},
				cwd: FIXTURES_DIR,
			});
			const decision = evaluatePreToolUse(
				event,
				rules,
				session,
				reservations,
				cohort,
			);
			const warning = findGraphWarning(decision.warnings);
			expect(warning).toBeDefined();
			expect(warning).toContain("high-risk.ts:");
			expect(warning).toContain("HIGH-risk edit");
		},
	);

	it("respects `*** Move to:` retargeting in apply_patch", () => {
		const event = makeEvent({
			tool_name: "apply_patch",
			tool_input: {
				command: [
					"*** Begin Patch",
					"*** Update File: dummy.ts",
					"*** Move to: high-risk.ts",
					"@@",
					" foo",
					"*** End Patch",
				].join("\n"),
			},
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const warning = findGraphWarning(decision.warnings);
		expect(warning).toBeDefined();
		expect(warning).toContain("high-risk.ts:");
		expect(warning).not.toContain("dummy.ts:");
	});

	it("covers Cursor-shape `target_file` tool input", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { target_file: "high-risk.ts", content: "// stub" },
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const warning = findGraphWarning(decision.warnings);
		expect(warning).toBeDefined();
		expect(warning).toContain("high-risk.ts:");
	});

	it("covers event-level `files_modified` array (no tool_input.file_path)", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { content: "// stub" },
			files_modified: ["high-risk.ts"],
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const warning = findGraphWarning(decision.warnings);
		expect(warning).toBeDefined();
		expect(warning).toContain("high-risk.ts:");
	});

	it("does not invoke graph awareness on Read tool", () => {
		const event = makeEvent({
			tool_name: "Read",
			tool_input: { file_path: "high-risk.ts" },
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(findGraphWarning(decision.warnings)).toBeUndefined();
	});

	it("emits a [calls] context line for a HIGH-risk file with >= 2 caller sites", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { file_path: "high-risk.ts", content: "// stub" },
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const graphWarnings = findAllGraphWarnings(decision.warnings);
		expect(graphWarnings).toHaveLength(2); // [impact] line + [calls] line
		const callLine = graphWarnings.find((w) =>
			w.includes("call graph per .graph shard"),
		);
		expect(callLine).toBeDefined();
		expect(callLine).toContain("high-risk.ts:");
		expect(callLine).toContain("2 caller site(s) into 1 function(s)");
		expect(callLine).toContain("process (2 callers)");
	});

	it("orders the [calls] line after the [impact] line", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { file_path: "high-risk.ts", content: "// stub" },
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const graphWarnings = findAllGraphWarnings(decision.warnings);
		expect(graphWarnings[0]).toContain("HIGH-risk edit");
		expect(graphWarnings[1]).toContain("call graph per .graph shard");
	});

	it("does not emit a [calls] line below the 2-caller threshold", () => {
		// medium-risk.graph.ts carries a [calls] section with a single caller.
		const event = makeEvent({
			tool_name: "Edit",
			tool_input: {
				file_path: "medium-risk.ts",
				old_string: "a",
				new_string: "b",
			},
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const graphWarnings = findAllGraphWarnings(decision.warnings);
		expect(graphWarnings).toHaveLength(1); // [impact] only
		expect(graphWarnings[0]).not.toContain("call graph per .graph shard");
	});

	it("does not emit a [calls] line when the shard has no [calls] section", () => {
		// no-affects.graph.ts is HIGH-risk but carries only an [impact] section.
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { file_path: "no-affects.ts", content: "// stub" },
			cwd: FIXTURES_DIR,
		});
		const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const graphWarnings = findAllGraphWarnings(decision.warnings);
		expect(graphWarnings).toHaveLength(1);
		expect(graphWarnings[0]).not.toContain("call graph");
	});

	it("stays fully silent on a LOW-impact file even when callers are present", () => {
		// The [calls] line is gated behind the [impact] line: a LOW-rated file
		// with external callers must still produce zero warnings — plan 07's
		// "LOW edits are silent" guarantee.
		const dir = mkdtempSync(join(tmpdir(), "supermodel-lowcalls-"));
		try {
			writeFileSync(
				join(dir, "x.graph.ts"),
				[
					"// @generated supermodel-shard — do not edit",
					"// [calls]",
					"// run ← a    src/a.ts:1",
					"// run ← b    src/b.ts:2",
					"// run ← c    src/c.ts:3",
					"// [impact]",
					"// risk        LOW",
					"// direct      3",
					"// transitive  3",
					"// affects     src/a.ts · src/b.ts · src/c.ts",
				].join("\n"),
			);
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "x.ts", content: "// stub" },
				cwd: dir,
			});
			const decision = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(findAllGraphWarnings(decision.warnings)).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
