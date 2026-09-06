import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFindings } from "../harness/findings/corpus.js";
import {
	loadSimplificationRunReceipts,
	simplificationRunsPath,
	type SimplificationRecordedStatus,
	type SimplificationRunReceipt,
} from "../harness/findings/simplification-record.js";
import { parseSimplificationReport } from "../lib/simplification-schema.js";
import {
	SIMPLIFICATION_REPORT_SCHEMA_VERSION,
	type SimplificationFinding,
	type SimplificationReport,
} from "../lib/simplification-types.js";
import {
	buildSimplificationReport,
	groupOverlappingFindings,
	renderSimplificationStatus,
	renderSimplificationText,
	simplifyCommand,
	simplifyStatusCommand,
} from "./simplify.js";

let fixture: string;
let previousInterlinkedHome: string | undefined;

function git(args: string[]): string {
	return execFileSync("git", args, {
		cwd: fixture,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function write(rel: string, content: string): void {
	const path = join(fixture, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function commitFixture(): void {
	git(["add", "-A"]);
	git([
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@invalid.local",
		"commit",
		"-q",
		"-m",
		"fixture",
	]);
}

function requireFinding(
	report: SimplificationReport,
	source: string,
	path: string,
): SimplificationFinding {
	const finding = report.findings.find((candidate) =>
		candidate.source === source && candidate.location.path === path
	);
	if (!finding) throw new Error(`missing ${source} finding at ${path}`);
	return finding;
}

beforeEach(() => {
	previousInterlinkedHome = process.env.INTERLINKED_HOME;
	fixture = mkdtempSync(join(tmpdir(), "interlinked-simplify-"));
	process.env.INTERLINKED_HOME = join(fixture, "fake-home");
	git(["init", "-q"]);
	write("package.json", JSON.stringify({ name: "simplify-fixture", bin: "./dist/index.js" }));
	write(
		"src/index.ts",
		'import { MemoryStore } from "./store.js";\nconsole.log(new MemoryStore().get());\n',
	);
	write("src/contracts.ts", "export interface Store { get(): string; }\n");
	write(
		"src/store.ts",
		'import type { Store } from "./contracts.js";\nexport class MemoryStore implements Store { get(): string { return "ok"; } }\n',
	);
	write("src/orphan.ts", "export const abandoned = 1;\n");
	commitFixture();
});

afterEach(() => {
	if (previousInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = previousInterlinkedHome;
	rmSync(fixture, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("buildSimplificationReport", () => {
	// test-contract: public-api — local scan emits the shared strict schema and
	// keeps every unvalidated detector result advisory/read-only
	it("emits canonical evidence without invented validation", () => {
		const report = buildSimplificationReport("scan", { cwd: fixture });
		expect(parseSimplificationReport(report)).not.toBeNull();
		expect(report.read_only).toBe(true);
		expect(report.findings.every((finding) => finding.auto_fix === false)).toBe(true);
		expect(report.findings.every((finding) => finding.impact.validated === null)).toBe(true);
	});

	// test-contract: invariant — unchanged evidence produces stable finding
	// fingerprints instead of per-run identities
	it("keeps fingerprints stable for unchanged source", () => {
		const first = buildSimplificationReport("scan", { cwd: fixture });
		const second = buildSimplificationReport("scan", { cwd: fixture });
		expect(second.findings.map((finding) => finding.fingerprint)).toEqual(
			first.findings.map((finding) => finding.fingerprint),
		);
	});

	// test-contract: invariant — source anchors may move while the underlying
	// simplification identity remains stable for the same path/source/remedy/key
	it("keeps a finding fingerprint stable across unrelated line movement", () => {
		const wrapper = "function trimValue(value: string): string { return value.trim(); }\nconsole.log(trimValue(' x '));\n";
		write("src/wrapper.ts", wrapper);
		const before = requireFinding(
			buildSimplificationReport("scan", { cwd: fixture }),
			"opportunity.delegate_only_wrapper",
			"src/wrapper.ts",
		);
		write(
			"src/wrapper.ts",
			`const unrelated = 1;\nconst alsoUnrelated = 2;\n${wrapper}`,
		);
		const after = requireFinding(
			buildSimplificationReport("scan", { cwd: fixture }),
			"opportunity.delegate_only_wrapper",
			"src/wrapper.ts",
		);
		expect(before.location.start_line).toBe(1);
		expect(after.location.start_line).toBe(2);
		expect(after.fingerprint).toBe(before.fingerprint);
	});

	// test-contract: public-api — review defaults to changed scope and uses the
	// repository-wide implementor context for a changed interface
	it("filters review findings to changed paths", () => {
		write("src/contracts.ts", "export interface Store { get(): string; size(): number; }\n");
		const report = buildSimplificationReport("review", { cwd: fixture });
		expect(report.scope.kind).toBe("changed");
		expect(report.scope.selected_paths).toEqual(["src/contracts.ts"]);
		expect(report.findings.some((finding) =>
			finding.source === "verify.single_implementation_interface",
		)).toBe(true);
	});

	// test-contract: public-api — deep audit and diff review prepare portable requests and
	// explicitly records that nothing was submitted
	it("prepares but does not submit the deep handoff", () => {
		const report = buildSimplificationReport("audit", { cwd: fixture, deepHandoff: true });
		const review = buildSimplificationReport("review", {
			cwd: fixture,
			staged: true,
			deepHandoff: true,
		});
		expect(report.deep_handoff?.submission.status).toBe("not_submitted");
		expect(review.deep_handoff?.submission.status).toBe("not_submitted");
		expect(report.deep_handoff?.requested_remedies).toEqual([
			"delete",
			"stdlib",
			"native",
			"yagni",
			"shrink",
		]);
	});

	it("requires pinned Git identities only when a deep handoff is requested", () => {
		const nongit = mkdtempSync(join(tmpdir(), "interlinked-simplify-nongit-"));
		try {
			const packagePath = join(nongit, "package.json");
			const sourcePath = join(nongit, "src", "index.ts");
			mkdirSync(dirname(sourcePath), { recursive: true });
			writeFileSync(packagePath, JSON.stringify({ name: "nongit" }));
			writeFileSync(sourcePath, "export const value = 1;\n");
			expect(() => buildSimplificationReport("audit", {
				cwd: nongit,
				deepHandoff: true,
			})).toThrow("requires a Git commit and tree identity");
			expect(buildSimplificationReport("audit", { cwd: nongit }).deep_handoff).toBeNull();
		} finally {
			rmSync(nongit, { recursive: true, force: true });
		}
	});

	// test-contract: boundary — an empty staged scope is still a covered result,
	// never an unqualified global claim
	it("uses the bounded empty-result wording", () => {
		const report = buildSimplificationReport("review", { cwd: fixture, staged: true });
		const text = renderSimplificationText(report);
		expect(report.coverage).toMatchObject({
			status: "complete",
			selected_files: 0,
			analyzed_files: 0,
		});
		expect(report.coverage.sources).toEqual([]);
		expect(text).toContain("No findings in covered scope.");
		expect(text.toLowerCase()).not.toContain("lean already");
	});

	// test-contract: boundary — two scope selectors are a caller error, never a
	// silent precedence rule
	it("refuses more than one review scope selector", () => {
		expect(() => buildSimplificationReport("review", {
			cwd: fixture,
			changed: true,
			staged: true,
		})).toThrow("choose exactly one review scope: --changed, --staged, or --range");
	});

	// test-contract: public-api — an explicit range pins both endpoints and
	// selects only the paths that changed between them
	it("scopes a review to an explicit commit range", () => {
		write("src/orphan.ts", "export const abandoned = 2;\n");
		commitFixture();
		const report = buildSimplificationReport("review", {
			cwd: fixture,
			range: "HEAD~1..HEAD",
		});
		expect(report.scope.kind).toBe("range");
		expect(report.scope.range).toBe("HEAD~1..HEAD");
		expect(report.scope.selected_paths).toEqual(["src/orphan.ts"]);
	});

	// test-contract: invariant — a candidate is in scope when a related path is
	// selected, so changing the only implementor surfaces its interface
	it("keeps an interface candidate whose only implementor changed", () => {
		write(
			"src/store.ts",
			'import type { Store } from "./contracts.js";\nexport class MemoryStore implements Store { get(): string { return "changed"; } }\n',
		);
		const report = buildSimplificationReport("review", { cwd: fixture });
		expect(report.scope.selected_paths).toEqual(["src/store.ts"]);
		const finding = requireFinding(
			report,
			"verify.single_implementation_interface",
			"src/contracts.ts",
		);
		expect(finding.remedy).toBe("yagni");
	});
});

function withLocation(
	fingerprint: string,
	path: string,
	startLine: number | null,
	endLine: number | null,
	dependencies: string[] = [],
): SimplificationFinding {
	return {
		fingerprint,
		lens: "simplification",
		source: "test.detector",
		remedy: "shrink",
		evidence_state: "candidate",
		confidence: 0.5,
		location: {
			path,
			start_line: startLine,
			end_line: endLine,
			tree_sha: "tree",
			working_tree_sha256: "worktree",
		},
		summary: fingerprint,
		replacement: null,
		evidence: [],
		impact: {
			estimated: { loc: null, dependencies_removed: dependencies },
			validated: null,
		},
		overlap_group: null,
		validation: {
			status: "not_run",
			executor: null,
			commands: [],
			artifact_sha: null,
			notes: [],
		},
		advisory: true,
		auto_fix: false,
	};
}

describe("groupOverlappingFindings", () => {
	it("keeps same-file non-overlapping candidates independent", () => {
		const grouped = groupOverlappingFindings([
			withLocation("first", "src/a.ts", 2, 3),
			withLocation("second", "src/a.ts", 20, 22),
		]);
		expect(grouped.map((finding) => finding.overlap_group)).toEqual([null, null]);
	});

	it("groups transitive span and dependency overlap deterministically", () => {
		const findings = [
			withLocation("span-a", "src/a.ts", 2, 6),
			withLocation("span-b", "src/a.ts", 6, 8, ["left-pad"]),
			withLocation("dependency", "package.json", 1, 1, ["left-pad"]),
		];
		const grouped = groupOverlappingFindings(findings);
		expect(new Set(grouped.map((finding) => finding.overlap_group)).size).toBe(1);
		expect(grouped[0]?.overlap_group).toMatch(/^overlap:[a-f0-9]{16}$/);
		expect(groupOverlappingFindings([...findings].reverse())
			.map((finding) => finding.overlap_group)).toEqual([
			grouped[0]?.overlap_group,
			grouped[0]?.overlap_group,
			grouped[0]?.overlap_group,
		]);
	});

	// test-contract: boundary — a candidate with no known line span is never
	// merged into a same-file neighbour on span evidence alone
	it("treats an unknown line span as non-overlapping within one file", () => {
		const grouped = groupOverlappingFindings([
			withLocation("unknown-span", "src/a.ts", null, null),
			withLocation("known-span", "src/a.ts", 1, 40),
		]);
		expect(grouped.map((finding) => finding.overlap_group)).toEqual([null, null]);
	});

	// test-contract: invariant — a chain joined through two separate roots still
	// collapses to one component (the union-find path-compression path)
	it("collapses a two-root dependency chain into a single group", () => {
		const grouped = groupOverlappingFindings([
			withLocation("w", "src/w.ts", 1, 1, ["alpha"]),
			withLocation("x", "src/x.ts", 1, 1, ["beta"]),
			withLocation("y", "src/y.ts", 1, 1, ["beta", "gamma"]),
			withLocation("z", "src/z.ts", 1, 1, ["alpha", "gamma"]),
		]);
		const groups = grouped.map((finding) => finding.overlap_group);
		expect(new Set(groups).size).toBe(1);
		expect(groups[3]).toMatch(/^overlap:[a-f0-9]{16}$/);
	});
});

describe("renderSimplificationText", () => {
	// test-contract: boundary — the text lens stays bounded and says how many
	// findings it withheld instead of printing an unbounded list
	it("truncates the finding list and counts the remainder", () => {
		const base = buildSimplificationReport("scan", { cwd: fixture });
		const findings = Array.from({ length: 11 }, (_, index) =>
			withLocation(`finding-${index}`, `src/f${index}.ts`, index + 1, index + 1));
		const text = renderSimplificationText({
			...base,
			findings,
			summary: { ...base.summary, findings: findings.length },
		});
		expect(text).toContain("  src/f0.ts:1 [shrink/candidate] finding-0");
		expect(text).toContain("  … +1 more (use --json)");
		expect(text).not.toContain("src/f10.ts");
	});

	// test-contract: public-api — a prepared handoff is announced in text mode
	// and still described as not submitted
	it("announces a prepared but unsubmitted deep handoff", () => {
		const text = renderSimplificationText(
			buildSimplificationReport("audit", { cwd: fixture, deepHandoff: true }),
		);
		expect(text).toContain(
			"Deep Agent CI handoff request prepared but not submitted (use --json for the request).",
		);
		expect(text).toContain("Read-only advisory; no files changed and no fixes applied.");
	});
});

describe("simplifyCommand", () => {
	// test-contract: public-api — JSON mode prints exactly one parseable shared
	// report rather than mixing progress text into stdout
	it("prints one canonical JSON report", async () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value: string) => {
			output.push(String(value));
		});
		const code = await simplifyCommand("scan", { cwd: fixture, json: true });
		const parsed: unknown = JSON.parse(output.join("\n"));
		expect(code).toBe(0);
		expect(parseSimplificationReport(parsed)).not.toBeNull();
	});

	// test-contract: invariant — ordinary scans remain ephemeral and do not
	// create either the receipt stream or common-corpus rows
	it("does not persist without the explicit record flag", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		const code = await simplifyCommand("scan", { cwd: fixture });
		expect(code).toBe(0);
		expect(existsSync(simplificationRunsPath(fixture))).toBe(false);
		expect(loadFindings(fixture)).toEqual([]);
	});

	// test-contract: public-api — --record writes local evidence without
	// wrapping or otherwise changing canonical JSON report stdout
	it("records findings while keeping JSON output schema-stable", async () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value: string) => {
			output.push(String(value));
		});
		const code = await simplifyCommand("scan", { cwd: fixture, json: true, record: true });
		const parsed: unknown = JSON.parse(output.join("\n"));
		expect(code).toBe(0);
		expect(parseSimplificationReport(parsed)).not.toBeNull();
		expect(loadSimplificationRunReceipts(fixture)).toHaveLength(1);
		expect(loadFindings(fixture).every(
			(finding) => finding.extensions?.simplification !== undefined,
		)).toBe(true);
	});

	// test-contract: public-api — status is a local materialized receipt view
	// with the full run metadata in JSON mode
	it("reports locally recorded runs through simplify status", async () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value: string) => {
			output.push(String(value));
		});
		await simplifyCommand("review", { cwd: fixture, staged: true, record: true });
		output.length = 0;
		const code = simplifyStatusCommand({ cwd: fixture, json: true });
		const status = JSON.parse(output.join("\n")) as {
			run_count: number;
			runs: Array<{ report: { command: string } }>;
		};
		expect(code).toBe(0);
		expect(status.run_count).toBe(1);
		expect(status.runs[0]?.report.command).toBe("review");
	});

	// test-contract: public-api — a refused run still emits one parseable JSON
	// document carrying the reason, never a bare stack trace
	it("reports a scope conflict as a JSON error document", async () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value: string) => {
			output.push(String(value));
		});
		const code = await simplifyCommand("review", {
			cwd: fixture,
			json: true,
			changed: true,
			range: "HEAD~1..HEAD",
		});
		const parsed = JSON.parse(output.join("\n")) as { schema_version: number; error: string };
		expect(code).toBe(1);
		expect(parsed.schema_version).toBe(SIMPLIFICATION_REPORT_SCHEMA_VERSION);
		expect(parsed.error).toBe("choose exactly one review scope: --changed, --staged, or --range");
	});

	// test-contract: public-api — text mode keeps stdout clean and puts the
	// failure on stderr with the command it names
	it("writes the refusal to stderr in text mode", async () => {
		let stderr = "";
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
		const code = await simplifyCommand("review", { cwd: fixture, changed: true, staged: true });
		expect(code).toBe(1);
		expect(stderr).toBe(
			"Simplify review unavailable: choose exactly one review scope: --changed, --staged, or --range\n",
		);
	});
});

describe("simplify status rendering", () => {
	function recordedStatus(runs: SimplificationRunReceipt[]): SimplificationRecordedStatus {
		return {
			schema_version: 1,
			kind: "simplification_recorded_status",
			root: fixture,
			runs_path: join(fixture, ".interlinked", "findings", "simplification-runs.jsonl"),
			corpus_path: join(fixture, ".interlinked", "findings", "corpus.jsonl"),
			run_count: runs.length,
			finding_observations: 0,
			corpus_findings: 0,
			latest_recorded_at: runs[0]?.recorded_at ?? null,
			runs,
		};
	}

	// test-contract: boundary — an empty record set names the flag that fills it
	// rather than rendering an empty table
	it("tells an unrecorded repository how to start recording", () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value: string) => {
			output.push(String(value));
		});
		const code = simplifyStatusCommand({ cwd: fixture });
		const lines = output.join("\n").split("\n");
		expect(code).toBe(0);
		expect(lines[0]).toBe(
			"Simplification records — 0 local run(s); 0 common-corpus finding(s) from 0 recorded observation(s)",
		);
		expect(lines[1]).toBe(
			"No recorded simplification runs. Add --record to simplify scan, review, or audit.",
		);
		expect(lines.at(-2)).toBe(
			`Run receipts: ${join(fixture, ".interlinked", "findings", "simplification-runs.jsonl")}`,
		);
		expect(lines.at(-1)).toBe(
			`Common corpus: ${join(fixture, ".interlinked", "findings", "corpus.jsonl")}`,
		);
	});

	// test-contract: public-api — one recorded run renders as a single receipt
	// row with its command, short fingerprint, count, coverage, and tree
	it("renders one recorded run as a receipt row", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		await simplifyCommand("review", { cwd: fixture, staged: true, record: true });
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value: string) => {
			output.push(String(value));
		});
		const code = simplifyStatusCommand({ cwd: fixture });
		const text = output.join("\n");
		expect(code).toBe(0);
		expect(text.split("\n")[0]).toBe(
			"Simplification records — 1 local run(s); 0 common-corpus finding(s) from 0 recorded observation(s)",
		);
		expect(text).toMatch(
			/^ {2}\S+ review [0-9a-f]{12} — 0 finding\(s\), coverage complete, tree [0-9a-f]{12}$/m,
		);
	});

	// test-contract: boundary — the receipt list is capped like the finding list
	// and reports how many older runs it withheld
	it("caps the receipt list and counts the older runs", () => {
		const report = buildSimplificationReport("scan", { cwd: fixture });
		const runs = Array.from({ length: 11 }, (_, index): SimplificationRunReceipt => ({
			schema_version: 1,
			kind: "simplification_run",
			run_fingerprint: `${index}`.padStart(12, "0"),
			recorded_at: `2026-09-04T00:00:${`${index}`.padStart(2, "0")}Z`,
			report,
			corpus_finding_ids: [],
		}));
		const text = renderSimplificationStatus(recordedStatus(runs));
		expect(text).toContain("2026-09-04T00:00:00Z scan 000000000000 —");
		expect(text).toContain("  … +1 older run(s) (use --json)");
		expect(text).not.toContain("000000000010");
	});

	// test-contract: boundary — a run recorded outside a Git tree still renders
	// a row, marked as having no tree identity
	it("marks a run with no tree identity", () => {
		const report = buildSimplificationReport("scan", { cwd: fixture });
		const text = renderSimplificationStatus(recordedStatus([{
			schema_version: 1,
			kind: "simplification_run",
			run_fingerprint: "ffffffffffff",
			recorded_at: "2026-09-04T00:00:00Z",
			report: { ...report, repository: { ...report.repository, tree_sha: null } },
			corpus_finding_ids: [],
		}]));
		expect(text).toContain("scan ffffffffffff — ");
		expect(text).toContain(", tree no-tree");
	});

	// test-contract: boundary — an unreadable local corpus is reported as a
	// status error document, not a crash
	it("reports an unreadable corpus as a JSON status error", () => {
		mkdirSync(join(fixture, ".interlinked", "findings", "corpus.jsonl"), { recursive: true });
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value: string) => {
			output.push(String(value));
		});
		const code = simplifyStatusCommand({ cwd: fixture, json: true });
		const parsed = JSON.parse(output.join("\n")) as {
			schema_version: number;
			kind: string;
			error: string;
		};
		expect(code).toBe(1);
		expect(parsed.schema_version).toBe(1);
		expect(parsed.kind).toBe("simplification_recorded_status");
		expect(parsed.error).toContain("EISDIR");
	});

	// test-contract: public-api — the text-mode status failure goes to stderr
	// with the same prefix the JSON mode names in its error field
	it("writes an unreadable-corpus failure to stderr in text mode", () => {
		mkdirSync(join(fixture, ".interlinked", "findings", "corpus.jsonl"), { recursive: true });
		let stderr = "";
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
		const code = simplifyStatusCommand({ cwd: fixture });
		expect(code).toBe(1);
		expect(stderr.startsWith("Simplify status unavailable: EISDIR")).toBe(true);
		expect(stderr.endsWith("\n")).toBe(true);
	});
});
