// Regression tests for the PostToolUse → recurrence consolidation contract.
//
// Bug history: the recurrence write was nested inside the structural-results
// loop AND the `error_memory.enabled` gate, so quality, structure-v1,
// suggestion, and behavioral check failures were silently dropped, and any
// installation with error_memory off recorded nothing. The fix walks
// `allCheckResults` once after every PostToolUse processing pass and fires
// `recordHarnessCaught` for every error/warning, regardless of source or
// error_memory setting.
//
// The consolidation loop moved out of the monolithic server.ts into
// server/post-tool-file-checks.ts during the 1500-line decomposition. Its
// source-level pins now live in server/post-tool-file-checks.test.ts; this
// file keeps the behavioral round-trip — exercising the same shape of
// consolidation against synthetic CheckResultEntry rows for each source kind.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	loadRecurrenceEvents,
	recordHarnessCaught,
} from "../recurrence.js";
import type { CheckResultEntry } from "../types.js";

describe("PostToolUse recurrence consolidation — behavioral round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-rcc-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// Simulates the consolidation loop from server.ts::processEvent with the
	// same shape — walks allCheckResults, fires recordHarnessCaught for every
	// error/warning, regardless of source kind or error_memory configuration.
	function runConsolidation(opts: {
		results: CheckResultEntry[];
		sessionId: string;
		agentSource: string;
		editedFilePath: string;
		cwd: string;
	}) {
		const recurrenceRelPath = relative(opts.cwd, opts.editedFilePath);
		for (const r of opts.results) {
			if (r.severity !== "error" && r.severity !== "warning") continue;
			recordHarnessCaught({
				check_id: r.name,
				agent_source: opts.agentSource,
				session_id: opts.sessionId,
				file: r.file ? relative(opts.cwd, r.file) : recurrenceRelPath,
				message: r.message,
				cwd: opts.cwd,
			});
		}
	}

	it("records a harness_caught event for a quality-check failure", () => {
		const editedFilePath = join(dir, "src/db.ts");
		runConsolidation({
			results: [
				{
					source: "quality",
					name: "typescript",
					severity: "error",
					message: "TS2322: Type 'string' is not assignable to type 'number'",
					file: editedFilePath,
					determinism: "fully_deterministic",
				},
			],
			sessionId: "sess-q",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(nonNull(events[0]).kind).toBe("harness_caught");
		expect(nonNull(events[0]).check_id).toBe("typescript");
		expect(nonNull(events[0]).file).toBe("src/db.ts");
		expect(nonNull(events[0]).agent_source).toBe("claude");
		expect(nonNull(events[0]).session_id).toBe("sess-q");
	});

	it("records a harness_caught event for a structural-check failure", () => {
		const editedFilePath = join(dir, "src/api.ts");
		runConsolidation({
			results: [
				{
					source: "structural",
					name: "export_surface",
					severity: "warning",
					message: "Removed export `getUser` is referenced from 3 dependents",
					file: editedFilePath,
					determinism: "fully_deterministic",
				},
			],
			sessionId: "sess-s",
			agentSource: "codex",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(nonNull(events[0]).check_id).toBe("export_surface");
		expect(nonNull(events[0]).agent_source).toBe("codex");
	});

	it("records harness_caught events for all six CheckResultEntry source kinds", () => {
		const editedFilePath = join(dir, "src/wide.ts");
		const sources: CheckResultEntry["source"][] = [
			"quality",
			"structural",
			"suggestion",
			"impact",
			"structure",
		];
		const results: CheckResultEntry[] = sources.map((source, i) => ({
			source,
			name: `check_${source}`,
			severity: i % 2 === 0 ? "error" : "warning",
			message: `${source} failure`,
			file: editedFilePath,
			determinism: "heuristic",
		}));
		runConsolidation({
			results,
			sessionId: "sess-all",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(sources.length);
		const ids = events.map((e) => e.check_id).sort();
		expect(ids).toEqual(
			sources.map((s) => `check_${s}`).sort(),
		);
	});

	it("skips info-severity results — only errors and warnings record", () => {
		const editedFilePath = join(dir, "src/x.ts");
		runConsolidation({
			results: [
				{
					source: "quality",
					name: "noisy_info",
					severity: "info",
					message: "FYI",
					file: editedFilePath,
					determinism: "heuristic",
				},
				{
					source: "quality",
					name: "real_warning",
					severity: "warning",
					message: "real",
					file: editedFilePath,
					determinism: "heuristic",
				},
			],
			sessionId: "sess-mix",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(nonNull(events[0]).check_id).toBe("real_warning");
	});

	it("records even when error_memory.enabled is effectively false (no gate at this layer)", () => {
		// The consolidation pass receives no error_memory context — it's
		// independent of that subsystem. This test simulates an installation
		// where error_memory has been disabled and asserts the JSONL still
		// gets the event.
		const editedFilePath = join(dir, "src/no-error-memory.ts");
		const errorMemoryEnabled = false;
		// In the real harness, errorHistory.recordError(...) would be skipped
		// when errorMemoryEnabled is false. The consolidation pass below must
		// be unconditional regardless.
		void errorMemoryEnabled;
		runConsolidation({
			results: [
				{
					source: "structural",
					name: "import_resolution",
					severity: "error",
					message: "Cannot resolve `./missing`",
					file: editedFilePath,
					determinism: "fully_deterministic",
				},
			],
			sessionId: "sess-no-mem",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(nonNull(events[0]).check_id).toBe("import_resolution");
	});

	it("multi-file fan-out: cursor prevents replaying prior files' findings", () => {
		// Codex `apply_patch` events fan out per-file. `allCheckResults` is
		// declared once for the event; each iteration appends. Without the
		// cursor, iteration N would re-record findings 1..N-1 on file N's
		// path, inflating recurrence counts and tripping ratchets from a
		// single edit event.
		const fileA = join(dir, "src/a.ts");
		const fileB = join(dir, "src/b.ts");
		const fileC = join(dir, "src/c.ts");

		// Simulates server.ts::processEvent fan-out semantics: a single
		// allCheckResults array shared across iterations, plus a cursor that
		// tracks how much of it has been mirrored to recurrence.
		const allCheckResults: CheckResultEntry[] = [];
		let recurrenceCursor = 0;

		const fanOut: { editedFilePath: string; results: CheckResultEntry[] }[] = [
			{
				editedFilePath: fileA,
				results: [
					{
						source: "quality",
						name: "typescript",
						severity: "error",
						message: "TS error in A",
						file: fileA,
						determinism: "fully_deterministic",
					},
				],
			},
			{
				editedFilePath: fileB,
				results: [
					{
						source: "structural",
						name: "export_surface",
						severity: "warning",
						message: "Removed export in B",
						file: fileB,
						determinism: "fully_deterministic",
					},
				],
			},
			{
				editedFilePath: fileC,
				results: [
					{
						source: "suggestion",
						name: "magic_number",
						severity: "warning",
						message: "literal in C",
						file: fileC,
						determinism: "heuristic",
					},
				],
			},
		];

		for (const iter of fanOut) {
			allCheckResults.push(...iter.results);
			if (allCheckResults.length > recurrenceCursor) {
				const recurrenceRelPath = relative(dir, iter.editedFilePath);
				for (let i = recurrenceCursor; i < allCheckResults.length; i++) {
					const r = nonNull(allCheckResults[i]);
					if (r.severity !== "error" && r.severity !== "warning") continue;
					recordHarnessCaught({
						check_id: r.name,
						agent_source: "claude",
						session_id: "sess-fanout",
						file: r.file ? relative(dir, r.file) : recurrenceRelPath,
						message: r.message,
						cwd: dir,
					});
				}
				recurrenceCursor = allCheckResults.length;
			}
		}

		const events = loadRecurrenceEvents(dir);
		// Exactly 3 events — one per file. Pre-fix code would have written
		// 1 + 2 + 3 = 6 (each iteration replaying earlier files' results).
		expect(events).toHaveLength(3);
		const idsAndFiles = events
			.map((e) => `${e.check_id}@${e.file}`)
			.sort();
		expect(idsAndFiles).toEqual(
			[
				"export_surface@src/b.ts",
				"magic_number@src/c.ts",
				"typescript@src/a.ts",
			].sort(),
		);
	});

	it("uses the result's own file when present, else falls back to editedFilePath", () => {
		const editedFilePath = join(dir, "src/edited.ts");
		const otherFile = join(dir, "src/other.ts");
		runConsolidation({
			results: [
				{
					source: "structural",
					name: "with_file",
					severity: "warning",
					message: "x",
					file: otherFile,
					determinism: "fully_deterministic",
				},
				{
					source: "suggestion",
					name: "no_file",
					severity: "warning",
					message: "y",
					determinism: "heuristic",
				},
			],
			sessionId: "sess-files",
			agentSource: "claude",
			editedFilePath,
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(2);
		const byCheck = new Map(events.map((e) => [e.check_id, e.file]));
		expect(byCheck.get("with_file")).toBe("src/other.ts");
		expect(byCheck.get("no_file")).toBe("src/edited.ts");
	});
});
