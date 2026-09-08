import { nonNull } from "../lib/non-null.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findingsCorpusPath, loadFindings, makeFinding, recordFinding } from "../harness/findings/corpus.js";
import { loadReconciliation, reconciliationStateOf } from "../harness/spec/reconciliation.js";
import {
	ingestReviewReport,
	isReviewFinding,
	registerFindingsCommands,
	verifyFindingAnchors,
} from "./findings.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// `recordFinding` mirrors every write into `~/.interlinked/findings-corpus.jsonl`
// (a real cross-repo cache) unless told otherwise. Every test in this file goes
// through `ingestReviewReport` → `upsertFinding` → `recordFinding` with no
// override, so without this isolation each run appends to the ACTUAL user home
// directory — confirmed on disk (2026-07-31) before this fix. `INTERLINKED_HOME`
// is the documented override (corpus.ts::globalCorpusPath); point it at a throwaway
// tmpdir for the whole file.
let prevInterlinkedHome: string | undefined;
beforeEach(() => {
	prevInterlinkedHome = process.env.INTERLINKED_HOME;
	const fakeHome = mkdtempSync(join(tmpdir(), "findings-fake-home-"));
	roots.push(fakeHome);
	process.env.INTERLINKED_HOME = fakeHome;
});
afterEach(() => {
	if (prevInterlinkedHome === undefined) delete process.env.INTERLINKED_HOME;
	else process.env.INTERLINKED_HOME = prevInterlinkedHome;
});

/** Run `registerFindingsCommands` on a fresh Command, invoke it with `argv`
 *  (cwd-relative, as a real CLI invocation would), and return the captured
 *  `console.log` lines.
 *
 *  `process.cwd` is SPIED (mockReturnValue), not actually chdir'd: the four
 *  actions all read `process.cwd()` directly, so overriding its return value
 *  is enough to point them at the fixture — and `process.chdir()` is a real
 *  OS syscall that Node refuses to run inside a worker thread
 *  (`ERR_WORKER_UNSUPPORTED_OPERATION: process.chdir() is not supported in
 *  workers`, confirmed live: Stryker's vitest-runner executes the dry run in
 *  exactly such a worker, so a real chdir here makes the file unmeasurable —
 *  every test after the first chdir call fails the whole run, not just one
 *  assertion). `console.log` is spied rather than reassigned, matching the
 *  established pattern in `spec.test.ts`. */
async function runFindingsCli(cwd: string, argv: string[]): Promise<string[]> {
	const logs: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
	try {
		const program = new Command();
		registerFindingsCommands(program);
		await program.parseAsync(["node", "interlinked", ...argv]);
	} finally {
		cwdSpy.mockRestore();
		log.mockRestore();
	}
	return logs;
}

/** Run `fn` with `process.env.USER` pinned to `value` (or removed when
 *  `undefined`), restoring the prior value after — exercises the `ack`
 *  command's `process.env.USER ?? "unknown"` default deterministically,
 *  independent of whatever the ambient shell happens to export. */
async function withEnvUser<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.USER;
	if (value === undefined) delete process.env.USER;
	else process.env.USER = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.USER;
		else process.env.USER = prev;
	}
}

const REPORT = `
1. [severity: high] [src/a.ts:21] Four-digit dashed ids are never extracted.
   Evidence: const DASHED_ID_RE = /x/;
   Why: digit width.

2. [medium] The sequencing conflicts with the architecture overall.
   Why: judgment call, no anchor.

TOTAL: 2
`;

describe("ingestReviewReport", () => {
	it("records parsed findings into the corpus with provenance", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, REPORT);
		const summary = ingestReviewReport(report, "codex-sol", cwd);
		expect(summary).toEqual({ parsed: 2, recorded: 2, anchored: 1 });
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(2);
		const anchored = rows.find((r) => r.file === "src/a.ts");
		expect(anchored).toEqual(
			expect.objectContaining({ line: 21, severity: "high" }),
		);
		expect(anchored?.provenance[0]?.source_runner).toBe("codex-sol");
		expect(anchored?.provenance[0]?.quote).toContain("DASHED_ID_RE");
		// The corpus file is real JSONL on disk.
		expect(readFileSync(findingsCorpusPath(cwd), "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("re-ingesting the same report dedups rather than duplicating", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, REPORT);
		ingestReviewReport(report, "codex-sol", cwd);
		ingestReviewReport(report, "codex-sol", cwd);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.times_observed >= 1)).toBe(true);
	});

	it("distinct unanchored findings with shared leading words get distinct ids (round-2 #4)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(
			report,
			"1. [medium] The API must define retry behavior for writes.\n2. [medium] The API must define retry behavior for reads.\nTOTAL: 2",
		);
		ingestReviewReport(report, "sol", cwd);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.id)).size).toBe(2);
	});

	it("a second reviewer merges provenance instead of replacing (round-2 #6)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, "1. [high] [src/a.ts:21] Anchored defect.\nTOTAL: 1");
		ingestReviewReport(report, "reviewer-a", cwd);
		ingestReviewReport(report, "reviewer-b", cwd);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.source_runners.sort()).toEqual(["reviewer-a", "reviewer-b"]);
	});

	it("records a file:// url and a well-formed sha256 raw hash in provenance", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, REPORT);
		ingestReviewReport(report, "codex-sol", cwd);
		const anchored = loadFindings(cwd)
			.filter(isReviewFinding)
			.find((r) => r.file === "src/a.ts");
		expect(anchored?.provenance[0]?.url).toBe(`file://${report}#finding-1`);
		// 64 lowercase hex chars — a real sha256 digest, not a truncated/blank stub.
		expect(anchored?.provenance[0]?.raw_sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("uses the exact Evidence: quote verbatim when present (not the whole raw block)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, REPORT);
		ingestReviewReport(report, "codex-sol", cwd);
		const anchored = loadFindings(cwd)
			.filter(isReviewFinding)
			.find((r) => r.file === "src/a.ts");
		// Exact match, not `.toContain` — `raw` ALSO contains "DASHED_ID_RE" (it's
		// the whole finding block including the Evidence: line), so a loose
		// substring check can't tell "used p.quote" from "fell through to raw".
		expect(anchored?.provenance[0]?.quote).toBe("const DASHED_ID_RE = /x/;");
	});

	it("falls back to a 300-char slice of raw for quote when there is no Evidence: line", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		// No "Evidence:" line, so p.quote is undefined and the fallback
		// `p.raw.slice(0, 300)` applies. The marker sits past char 300 so it is
		// present in the untruncated raw but must be ABSENT from the stored quote.
		const longStatement = `${"A".repeat(310)}ZZMARKERZZ`;
		writeFileSync(report, `1. ${longStatement}\nTOTAL: 1`);
		ingestReviewReport(report, "codex-sol", cwd);
		const finding = loadFindings(cwd).filter(isReviewFinding)[0];
		expect(finding?.provenance[0]?.quote).toHaveLength(300);
		expect(finding?.provenance[0]?.quote).not.toContain("ZZMARKERZZ");
	});

	it("slugs bug_class exactly: lowercased, non-alphanumerics stripped, capped at 6 words", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		// The em-dash bullet is DELETED (not replaced with a space) by the
		// non-alnum strip, which unmasks the space that already followed it as a
		// leading whitespace run — this exercises `.filter(Boolean)` running
		// BEFORE `.slice(0, 6)` (a mutant that drops the filter would instead
		// waste a slot on that leading empty string and shift the whole result).
		// Mixed case + "-"/"!!"/","/"." exercise the lowercase + char-strip
		// regexes; 11 real words after "review_" exercises the 6-word cap.
		writeFileSync(
			report,
			"1. — Four-Digit   DASHED ids!! are never extracted, verified, tested, reported, filed today.\nTOTAL: 1",
		);
		ingestReviewReport(report, "x", cwd);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.bug_class).toBe("review_fourdigit_dashed_ids_are_never_extracted");
	});

	it('slugs to "review_unstated" when the statement has no alphanumeric words at all', () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, "1. !!! ??? ...\nTOTAL: 1");
		ingestReviewReport(report, "x", cwd);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.bug_class).toBe("review_unstated");
	});
});

describe("isReviewFinding", () => {
	it("is true for a bug_class with the review_ prefix", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const finding = makeFinding(
			{ bug_class: "review_some_defect", message: "m", source_runner: "x" },
			cwd,
		);
		expect(isReviewFinding(finding)).toBe(true);
	});

	it("is false for a bug_class without the review_ prefix (e.g. a harness-detected finding)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const finding = makeFinding(
			{ bug_class: "manual_check_something", message: "m", source_runner: "x" },
			cwd,
		);
		expect(isReviewFinding(finding)).toBe(false);
	});
});

describe("verifyFindingAnchors (LG-6)", () => {
	/** cwd + a real src/a.ts whose line 21 the REPORT's finding anchors. */
	function setup(): { cwd: string; target: string } {
		const cwd = mkdtempSync(join(tmpdir(), "findings-verify-"));
		roots.push(cwd);
		const lines = Array.from({ length: 25 }, (_, i) => `const filler${i + 1} = ${i + 1};`);
		lines[20] = "const DASHED_ID_RE = /^\\d{4}-\\d{4}$/;"; // line 21, the anchor
		const target = join(cwd, "src", "a.ts");
		writeFileSync(join(cwd, "review.md"), REPORT);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(target, `${lines.join("\n")}\n`);
		ingestReviewReport(join(cwd, "review.md"), "codex-sol", cwd);
		return { cwd, target };
	}

	it("classifies an untouched anchor live and skips unanchored findings", () => {
		const { cwd } = setup();
		const summary = verifyFindingAnchors(cwd, false);
		expect(summary.counts.live).toBe(1);
		expect(summary.rows).toHaveLength(1); // the unanchored finding is skipped
	});

	it("detects a move after insertions above, re-anchors with --write, then reads live", () => {
		const { cwd, target } = setup();
		const original = readFileSync(target, "utf8");
		writeFileSync(target, `// new header\n// more header\n${original}`);

		const dryRun = verifyFindingAnchors(cwd, false);
		expect(dryRun.counts.moved).toBe(1);
		expect(dryRun.rows[0]?.newLine).toBe(23);
		// Dry run wrote nothing.
		expect(loadFindings(cwd).find((f) => f.file === "src/a.ts")?.line).toBe(21);

		const written = verifyFindingAnchors(cwd, true);
		expect(written.reanchored).toBe(1);
		const updated = loadFindings(cwd).find((f) => f.file === "src/a.ts");
		expect(updated?.line).toBe(23);
		// Reanchor is ledger maintenance: the finding stays OPEN, never closed.
		const recon = loadReconciliation(cwd);
		expect(updated && reconciliationStateOf(recon, updated.id)).toBe("open");
		// After re-anchoring, a fresh verify reads live.
		expect(verifyFindingAnchors(cwd, false).counts.live).toBe(1);
	});

	it("classifies changed content drifted and a deleted file gone — never auto-closing", () => {
		const { cwd, target } = setup();
		const original = readFileSync(target, "utf8");
		writeFileSync(target, original.replace("const DASHED_ID_RE", "const DASHED_ID_PATTERN"));
		expect(verifyFindingAnchors(cwd, true).counts.drifted).toBe(1);
		rmSync(target);
		expect(verifyFindingAnchors(cwd, true).counts.gone).toBe(1);
		const f = loadFindings(cwd).find((row) => row.file === "src/a.ts");
		expect(f && reconciliationStateOf(loadReconciliation(cwd), f.id)).toBe("open");
	});

	it("re-anchoring on --write records a well-formed reanchored txn (action/by/file/line), not an empty stub", () => {
		const { cwd, target } = setup();
		const original = readFileSync(target, "utf8");
		writeFileSync(target, `// new header\n// more header\n${original}`);
		verifyFindingAnchors(cwd, true);
		const updated = loadFindings(cwd).find((f) => f.file === "src/a.ts");
		const recon = loadReconciliation(cwd);
		// "open" alone doesn't distinguish a real reanchor txn from NO txn at all
		// (an untouched finding's default state is ALSO "open") — pin the txn's
		// own fields so a stubbed-out payload can't pass silently.
		expect(updated && recon.get(updated.id)?.last_txn).toEqual(
			expect.objectContaining({
				finding_id: updated?.id,
				action: "reanchored",
				by: "findings-verify",
				file: "src/a.ts",
				line: 23,
			}),
		);
	});

	it("excludes non-review findings from anchor verification entirely", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-verify-"));
		roots.push(cwd);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "c.ts"), "const X = 1;\n");
		// Injected directly (not via ingestReviewReport), so its bug_class carries
		// no "review_" prefix — the harness's own findings, for example.
		const manual = makeFinding(
			{
				bug_class: "manual_something",
				message: "not a review finding",
				source_runner: "manual",
				file: "src/c.ts",
				line: 1,
			},
			cwd,
		);
		recordFinding(manual, cwd, { mirrorGlobal: false });
		const summary = verifyFindingAnchors(cwd, false);
		expect(summary.rows).toHaveLength(0);
		expect(summary.counts).toEqual({ live: 0, moved: 0, drifted: 0, gone: 0, unverified: 0 });
	});

	it("skips an anchored finding with no line number (line 0) — neither counted nor rowed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-verify-"));
		roots.push(cwd);
		mkdirSync(join(cwd, "src"), { recursive: true });
		const lines = Array.from({ length: 10 }, (_, i) => `const filler${i + 1} = ${i + 1};`);
		lines[4] = "const MARK = 1;"; // line 5
		writeFileSync(join(cwd, "src", "a.ts"), `${lines.join("\n")}\n`);
		writeFileSync(
			join(cwd, "review.md"),
			[
				"1. [high] [src/a.ts:5] Anchored with a real line.",
				"   Evidence: const MARK = 1;",
				"2. [low] src/a.ts needs an update.", // file only, no ":line" -> line 0
				"TOTAL: 2",
			].join("\n"),
		);
		ingestReviewReport(join(cwd, "review.md"), "x", cwd);
		const lineless = loadFindings(cwd).find((f) => f.line === 0);
		expect(lineless).toBeDefined(); // sanity: the fixture really produced a line-0 row
		const summary = verifyFindingAnchors(cwd, false);
		expect(summary.rows).toHaveLength(1); // only the real anchor, never the line-0 one
		expect(summary.counts).toEqual({ live: 1, moved: 0, drifted: 0, gone: 0, unverified: 0 });
	});

	it("does NOT skip a finding anchored at exactly line 1 (0 is invalid, 1 is not)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-verify-"));
		roots.push(cwd);
		mkdirSync(join(cwd, "src"), { recursive: true });
		const lines = Array.from({ length: 10 }, (_, i) => `const filler${i + 1} = ${i + 1};`);
		lines[0] = "const FIRSTLINE = 1;"; // line 1
		writeFileSync(join(cwd, "src", "b.ts"), `${lines.join("\n")}\n`);
		writeFileSync(
			join(cwd, "review.md"),
			"1. [high] [src/b.ts:1] Anchored at line one.\n   Evidence: const FIRSTLINE = 1;\nTOTAL: 1",
		);
		ingestReviewReport(join(cwd, "review.md"), "x", cwd);
		const summary = verifyFindingAnchors(cwd, false);
		expect(summary.rows).toHaveLength(1);
		expect(summary.rows[0]?.state).toBe("live");
		expect(summary.counts.live).toBe(1);
	});
});

describe("registerFindingsCommands — ingest subcommand", () => {
	it("parses via the CLI, writes the corpus, and prints the recorded/anchored counts", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-ingest-")));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, REPORT);
		const logs = await runFindingsCli(cwd, ["findings", "ingest", report, "--reviewer", "codex-sol"]);
		expect(logs[0]).toBe(
			`Ingested 2/2 finding(s) from review.md (1 with file anchors) → ${findingsCorpusPath(cwd)}`,
		);
		expect(logs[1]).toContain("interlinked findings ack <id> --reason");
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.source_runners.includes("codex-sol"))).toBe(true);
	});

	it("defaults --reviewer to external-review when the flag is omitted", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-ingest-default-")));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, "1. [high] [src/a.ts:3] A defect with no explicit reviewer.\nTOTAL: 1");
		await runFindingsCli(cwd, ["findings", "ingest", report]);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.source_runners).toEqual(["external-review"]);
	});

	it("records unknown severity for a finding with no severity bracket at all", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-ingest-unknown-sev-")));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, "1. src/b.ts:5 has no severity bracket at all.\nTOTAL: 1");
		const logs = await runFindingsCli(cwd, ["findings", "ingest", report]);
		expect(logs[0]).toContain("Ingested 1/1 finding(s)");
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.severity).toBe("unknown");
	});
});

describe("registerFindingsCommands — status subcommand", () => {
	it("prints total/open/touched/acked counts, filters non-open rows by default, and reveals them with --all", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-status-")));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(
			report,
			[
				"1. [high] [src/a.ts:21] Anchored with a line.",
				"2. [medium] Unanchored, no file at all.",
				"3. [low] docs/plan.md needs an update.",
				"TOTAL: 3",
			].join("\n"),
		);
		ingestReviewReport(report, "codex-sol", cwd);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		const anchoredWithLine = rows.find((r) => r.file === "src/a.ts");
		const anchoredNoLine = rows.find((r) => r.file === "docs/plan.md");
		const unanchored = rows.find((r) => r.file === "");
		expect(anchoredWithLine).toBeDefined();
		expect(anchoredNoLine).toBeDefined();
		expect(unanchored).toBeDefined();

		// Ack the anchored-with-line finding so `status` has a non-open row to
		// filter (default) and reveal (--all).
		await withEnvUser("ambient-user", () =>
			runFindingsCli(cwd, [
				"findings",
				"ack",
				(nonNull(anchoredWithLine)).id,
				"--reason",
				"known, deferred",
				"--by",
				"tester",
			]),
		);

		const defaultLogs = await runFindingsCli(cwd, ["findings", "status"]);
		expect(defaultLogs[0]).toBe("Review findings: 3 total — 2 open, 0 touched, 1 acked");
		// The acked row is filtered out by default (state !== "open").
		expect(defaultLogs.some((l) => l.includes((nonNull(anchoredWithLine)).id))).toBe(
			false,
		);
		// A truthy `file` with a falsy `line` (0) prints the file with no ":line".
		expect(defaultLogs).toContainEqual(
			`  [open] ${(nonNull(anchoredNoLine)).id} docs/plan.md — docs/plan.md needs an update.`,
		);
		// A fully unanchored finding prints with no trailing anchor at all.
		expect(defaultLogs).toContainEqual(
			`  [open] ${(nonNull(unanchored)).id} — Unanchored, no file at all.`,
		);
		expect(defaultLogs).toHaveLength(3); // header + 2 open rows (acked row filtered)

		const allLogs = await runFindingsCli(cwd, ["findings", "status", "--all"]);
		expect(allLogs).toContainEqual(
			`  [acked] ${(nonNull(anchoredWithLine)).id} src/a.ts:21 — Anchored with a line.`,
		);
		expect(allLogs).toHaveLength(4); // header + all 3 rows, acked now visible
	});

	it("excludes non-review findings from both the summary counts and the listing", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-status-nonreview-")));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, "1. [high] [src/a.ts:21] A real review finding.\nTOTAL: 1");
		ingestReviewReport(report, "codex-sol", cwd);
		// A harness-detected (non-review) finding recorded directly in the SAME
		// corpus — `status` must not count or print it.
		const manual = makeFinding(
			{ bug_class: "manual_something", message: "not a review finding", source_runner: "manual" },
			cwd,
		);
		recordFinding(manual, cwd, { mirrorGlobal: false });
		const logs = await runFindingsCli(cwd, ["findings", "status"]);
		expect(logs[0]).toBe("Review findings: 1 total — 1 open, 0 touched, 0 acked");
		expect(logs.some((l) => l.includes("manual"))).toBe(false);
		expect(logs).toHaveLength(2); // header + the one real review row
	});

	it("truncates a long finding message to exactly 100 chars in the printed row", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-status-trunc-")));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		const longMessage = `${"L".repeat(150)}.`; // 151 chars; char 101+ must never print
		writeFileSync(report, `1. [high] ${longMessage}\nTOTAL: 1`);
		ingestReviewReport(report, "codex-sol", cwd);
		const logs = await runFindingsCli(cwd, ["findings", "status"]);
		const row = logs.find((l) => l.startsWith("  [open]"));
		expect(row).toBeDefined();
		const messagePart = row?.split(" — ")[1];
		expect(messagePart).toHaveLength(100);
		expect(messagePart).toBe("L".repeat(100));
	});
});

describe("registerFindingsCommands — verify subcommand", () => {
	/** Two anchored findings in a fresh repo: src/a.ts:21 and src/b.ts:10. */
	function setupTwoAnchors(): { cwd: string } {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-verify-")));
		roots.push(cwd);
		const lines = Array.from({ length: 25 }, (_, i) => `const filler${i + 1} = ${i + 1};`);
		lines[20] = "const DASHED_ID_RE = /^\\d{4}-\\d{4}$/;"; // line 21
		lines[9] = "const OTHER_MARK = 999;"; // line 10
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "a.ts"), `${lines.join("\n")}\n`);
		writeFileSync(join(cwd, "src", "b.ts"), `${lines.join("\n")}\n`);
		writeFileSync(
			join(cwd, "review.md"),
			[
				"1. [high] [src/a.ts:21] Anchor one.",
				"   Evidence: const DASHED_ID_RE = /x/;",
				"2. [medium] [src/b.ts:10] Anchor two.",
				"   Evidence: const OTHER_MARK = 999;",
				"TOTAL: 2",
			].join("\n"),
		);
		ingestReviewReport(join(cwd, "review.md"), "codex-sol", cwd);
		return { cwd };
	}

	it("dry-run: prints only the summary line when everything is live (no drifted note, no per-row lines)", async () => {
		const { cwd } = setupTwoAnchors();
		const logs = await runFindingsCli(cwd, ["findings", "verify"]);
		expect(logs).toEqual(["Anchors: 2 live, 0 moved, 0 drifted, 0 gone, 0 unverified"]);
	});

	it("--write re-anchors a moved finding and reports both a moved row and a drifted row, with the re-review note", async () => {
		const { cwd } = setupTwoAnchors();
		const a = join(cwd, "src", "a.ts");
		const b = join(cwd, "src", "b.ts");
		writeFileSync(a, `// header\n// header2\n${readFileSync(a, "utf8")}`);
		writeFileSync(b, readFileSync(b, "utf8").replace("const OTHER_MARK", "const OTHER_MARK_RENAMED"));

		const logs = await runFindingsCli(cwd, ["findings", "verify", "--write"]);
		expect(logs[0]).toBe(
			"Anchors: 0 live, 1 moved, 1 drifted, 0 gone, 0 unverified — re-anchored 1",
		);
		expect(logs).toContainEqual("  [moved] " + `${loadFindings(cwd).find((f) => f.file === "src/a.ts")?.id} src/a.ts:21 → :23 — Anchor one.`);
		expect(logs).toContainEqual(
			`  [drifted] ${loadFindings(cwd).find((f) => f.file === "src/b.ts")?.id} src/b.ts:10 — Anchor two.`,
		);
		expect(logs).toContainEqual(
			"Drifted findings need re-review (content changed at the anchor) — they are NOT auto-closed.",
		);
		// Re-running after the re-anchor reads the a.ts finding live (no more re-anchor to do).
		const rerun = await runFindingsCli(cwd, ["findings", "verify"]);
		expect(rerun[0]).toBe("Anchors: 1 live, 0 moved, 1 drifted, 0 gone, 0 unverified");
	});

	it("reports a deleted anchor file as gone", async () => {
		const { cwd } = setupTwoAnchors();
		rmSync(join(cwd, "src", "b.ts"));
		const logs = await runFindingsCli(cwd, ["findings", "verify"]);
		expect(logs[0]).toBe("Anchors: 1 live, 0 moved, 0 drifted, 1 gone, 0 unverified");
		expect(logs).toContainEqual(
			`  [gone] ${loadFindings(cwd).find((f) => f.file === "src/b.ts")?.id} src/b.ts:10 — Anchor two.`,
		);
		// A gone anchor is not "drifted" — the re-review note only fires on drift.
		expect(logs.some((l) => l.includes("need re-review"))).toBe(false);
	});

	it("a dry run (no --write) on a moved finding reports it but does NOT re-anchor the corpus", async () => {
		const { cwd } = setupTwoAnchors();
		const a = join(cwd, "src", "a.ts");
		writeFileSync(a, `// header\n// header2\n${readFileSync(a, "utf8")}`);

		const logs = await runFindingsCli(cwd, ["findings", "verify"]); // no --write
		expect(logs[0]).toBe("Anchors: 1 live, 1 moved, 0 drifted, 0 gone, 0 unverified");
		// No " — re-anchored N" suffix — `opts.write === true` must gate the
		// write path, not just default to on.
		expect(logs[0]).not.toContain("re-anchored");
		// The corpus itself must be untouched — the OLD line, not the new one.
		expect(loadFindings(cwd).find((f) => f.file === "src/a.ts")?.line).toBe(21);
	});

	it("truncates a long finding message to exactly 80 chars in a non-live row", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-verify-trunc-")));
		roots.push(cwd);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "a.ts"), "const X = 1;\n");
		const longMessage = `${"M".repeat(150)}.`; // 151 chars; char 81+ must never print
		writeFileSync(join(cwd, "review.md"), `1. [high] [src/a.ts:1] ${longMessage}\nTOTAL: 1`);
		ingestReviewReport(join(cwd, "review.md"), "x", cwd);
		rmSync(join(cwd, "src", "a.ts")); // force a non-live ("gone") row so it prints
		const logs = await runFindingsCli(cwd, ["findings", "verify"]);
		const row = logs.find((l) => l.startsWith("  [gone]"));
		expect(row).toBeDefined();
		const messagePart = row?.split(" — ")[1];
		expect(messagePart).toHaveLength(80);
		expect(messagePart).toBe("M".repeat(80));
	});
});

describe("registerFindingsCommands — ack subcommand", () => {
	it("appends an acked reconciliation txn with the given --reason and --by, and prints a confirmation", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-ack-")));
		roots.push(cwd);
		const logs = await withEnvUser("ambient-user", () =>
			runFindingsCli(cwd, [
				"findings",
				"ack",
				"some-finding-id",
				"--reason",
				"known, deferred to next sprint",
				"--by",
				"explicit-actor",
			]),
		);
		expect(logs).toEqual(["Acked some-finding-id: known, deferred to next sprint"]);
		const recon = loadReconciliation(cwd);
		expect(recon.get("some-finding-id")).toEqual(
			expect.objectContaining({
				state: "acked",
				last_txn: expect.objectContaining({
					finding_id: "some-finding-id",
					action: "acked",
					by: "explicit-actor",
					reason: "known, deferred to next sprint",
				}),
			}),
		);
		expect(reconciliationStateOf(recon, "some-finding-id")).toBe("acked");
	});

	it("defaults --by to process.env.USER when the flag is omitted", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-ack-default-user-")));
		roots.push(cwd);
		await withEnvUser("opusfive", () =>
			runFindingsCli(cwd, ["findings", "ack", "id-2", "--reason", "why"]),
		);
		const recon = loadReconciliation(cwd);
		expect(recon.get("id-2")?.last_txn?.by).toBe("opusfive");
	});

	it("falls back to \"unknown\" for --by when process.env.USER is unset", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "findings-cli-ack-no-user-")));
		roots.push(cwd);
		await withEnvUser(undefined, () =>
			runFindingsCli(cwd, ["findings", "ack", "id-3", "--reason", "why"]),
		);
		const recon = loadReconciliation(cwd);
		expect(recon.get("id-3")?.last_txn?.by).toBe("unknown");
	});
});

describe("registerFindingsCommands — registered CLI surface", () => {
	// Commander's `--help` output is built entirely from these description
	// strings; there is no separate behavior to assert beyond "the real
	// registered Command tree carries the intended text" — the same thing a
	// route table test asserts for an HTTP framework. Pinned as ONE test
	// instead of scattered per-string checks (added, or a typo introduced by a
	// future edit, shows up as one clear diff either way).
	it("registers findings + its 4 subcommands with the intended descriptions and options", async () => {
		await withEnvUser("fixed-user-for-default-pin", async () => {
			const program = new Command();
			registerFindingsCommands(program);
			const findings = program.commands.find((c) => c.name() === "findings");
			expect(findings?.description()).toBe(
				"Ingest external review findings and drive them to closure",
			);
			const byName = new Map(findings?.commands.map((c) => [c.name(), c]));

			expect(byName.get("ingest")?.description()).toBe(
				"Parse a numbered-findings review report into the corpus",
			);
			const reviewerOpt = byName.get("ingest")?.options.find((o) => o.flags === "--reviewer <name>");
			expect(reviewerOpt?.description).toBe("reviewer attribution");
			expect(reviewerOpt?.defaultValue).toBe("external-review");

			expect(byName.get("status")?.description()).toBe(
				"Reconciliation state of ingested review findings",
			);
			const allOpt = byName.get("status")?.options.find((o) => o.flags === "--all");
			expect(allOpt?.description).toBe("include touched/acked findings in the listing");

			expect(byName.get("verify")?.description()).toBe(
				"Re-verify finding anchors against the working tree (live/moved/drifted/gone)",
			);
			const writeOpt = byName.get("verify")?.options.find((o) => o.flags === "--write");
			expect(writeOpt?.description).toBe(
				"re-anchor moved findings (new corpus row + reanchored txn)",
			);

			expect(byName.get("ack")?.description()).toBe(
				"Acknowledge a finding as deliberately not addressed",
			);
			const reasonOpt = byName.get("ack")?.options.find((o) => o.flags === "--reason <text>");
			expect(reasonOpt?.description).toBe("why this finding is not being addressed");
			const byOpt = byName.get("ack")?.options.find((o) => o.flags === "--by <name>");
			expect(byOpt?.description).toBe("who is acking");
			expect(byOpt?.defaultValue).toBe("fixed-user-for-default-pin");
		});
	});
});
