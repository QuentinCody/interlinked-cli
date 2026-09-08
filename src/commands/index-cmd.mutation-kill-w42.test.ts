import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../harness/trigram-index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../harness/trigram-index.js")>();
	return { ...actual, TrigramIndex: class extends actual.TrigramIndex {
		static override build = vi.fn<typeof actual.TrigramIndex.build>();
		static override load = vi.fn<typeof actual.TrigramIndex.load>();
		static override loadMeta = vi.fn<typeof actual.TrigramIndex.loadMeta>();
	} };
});

vi.mock("../harness/regex-trigrams.js", () => ({
	decomposePattern: vi.fn(),
}));

import { decomposePattern } from "../harness/regex-trigrams.js";
import { TrigramIndex } from "../harness/trigram-index.js";
import { registerIndexCommand } from "./index-cmd.js";

function buildProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerIndexCommand(program);
	return program;
}

async function run(program: Command, args: string[]): Promise<void> {
	await program.parseAsync(["index", ...args], { from: "user" });
}

function dateNowSequence(values: number[]): () => number {
	let idx = 0;
	return () => {
		const last = values[values.length - 1] ?? 0;
		const v = idx < values.length ? values[idx] : last;
		idx++;
		return v ?? last;
	};
}

// Vitest spy handles carry awkward overloaded generics.
function logLines(logSpy: any): string[] {
	return logSpy.mock.calls.map((c: unknown[]) => c.join(" "));
}

describe("index-cmd — command/option descriptions (must fire on string-literal stripping)", () => {
	it("P1: every command and option carries its non-empty description text", () => {
		const program = buildProgram();
		const idx = program.commands.find((c) => c.name() === "index");
		expect(idx).toBeDefined();
		expect(idx?.description()).toBe("Manage the trigram search index for grep acceleration");

		const build = idx?.commands.find((c) => c.name() === "build");
		expect(build?.description()).toBe("Build a full trigram index from the current codebase");
		const buildOptDescs = build?.options.map((o) => o.description);
		expect(buildOptDescs).toContain("Working directory");
		expect(buildOptDescs).toContain("Skip files larger than this");
		expect(buildOptDescs).toContain("Stop trigram threshold (0-1)");

		const update = idx?.commands.find((c) => c.name() === "update");
		expect(update?.description()).toBe("Incrementally update the index from git changes");
		expect(update?.options.map((o) => o.description)).toContain("Working directory");

		const status = idx?.commands.find((c) => c.name() === "status");
		expect(status?.description()).toBe("Show index status and statistics");
		const statusOptDescs = status?.options.map((o) => o.description);
		expect(statusOptDescs).toContain("Working directory");
		expect(statusOptDescs).toContain("Output as JSON");

		const query = idx?.commands.find((c) => c.name() === "query");
		expect(query?.description()).toBe("Query the index for candidate files (debug tool)");
		const queryOptDescs = query?.options.map((o) => o.description);
		expect(queryOptDescs).toContain("Working directory");
		expect(queryOptDescs).toContain("Treat pattern as regex");
	});
});

describe("index-cmd — build command (elapsed arithmetic, progress threshold, base-commit slice, clear-line)", () => {
	// Vitest spy handles carry awkward overloaded generics.
	let logSpy: any;
	// Vitest spy handles carry awkward overloaded generics.
	let writeSpy: any;
	// Vitest spy handles carry awkward overloaded generics.
	let dateSpy: any;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		logSpy.mockRestore();
		writeSpy.mockRestore();
		dateSpy?.mockRestore();
		vi.mocked(TrigramIndex.build).mockReset();
	});

	it("P2: progress reporting fires only after the >500ms threshold is crossed", async () => {
		const index = new TrigramIndex([], new Map(), new Set(), "abcdef1234567890", "/repo");
		const saveMock = vi.fn();
		const statsMock = vi.fn(() => ({
			...index.stats(),
			fileCount: 1,
			trigramCount: 1,
			stopTrigramCount: 0,
			indexSizeBytes: 1,
			baseCommit: "abcdef1234567890",
		}));
		const stats = statsMock();
		vi.spyOn(index, "save").mockImplementation(saveMock);
		vi.spyOn(index, "stats").mockReturnValue(stats);
		vi.mocked(TrigramIndex.build).mockImplementation((opts) => {
			opts?.onProgress?.(1, 10);
			opts?.onProgress?.(2, 10);
			return index;
		});

		// startTime=0, onProgress#1 now=500 (500-0=500, NOT >500), onProgress#2 now=501 (501-0=501, >500)
		dateSpy = vi.spyOn(Date, "now").mockImplementation(dateNowSequence([0, 500, 501, 501]));

		const program = buildProgram();
		await run(program, ["build"]);

		const progressWrites = writeSpy.mock.calls
			.map((c: unknown[]) => c[0])
			.filter((s: unknown): s is string => typeof s === "string" && s.includes("Indexing"));
		expect(progressWrites).toEqual(["\r  Indexing... 2/10 files"]);
	});

	it("P3: elapsed seconds use (now-start)/1000 and base commit is sliced to 8 chars; clear-line write happens", async () => {
		const index = new TrigramIndex([], new Map(), new Set(), "abcdef1234567890", "/repo");
		const saveMock = vi.fn();
		const statsMock = vi.fn(() => ({
			...index.stats(),
			fileCount: 1,
			trigramCount: 1,
			stopTrigramCount: 0,
			indexSizeBytes: 1,
			baseCommit: "abcdef1234567890",
		}));
		const stats = statsMock();
		vi.spyOn(index, "save").mockImplementation(saveMock);
		vi.spyOn(index, "stats").mockReturnValue(stats);
		vi.mocked(TrigramIndex.build).mockReturnValue(index);

		// startTime=1000, elapsed calc now=4000 => (4000-1000)/1000 = 3.0
		dateSpy = vi.spyOn(Date, "now").mockImplementation(dateNowSequence([1000, 4000]));

		const program = buildProgram();
		await run(program, ["build"]);

		const logs = logLines(logSpy);
		expect(logs).toContain("Index built in 3.0s");
		expect(logs).toContain("  Base commit: abcdef12");
		expect(logs.find((l) => l.includes("abcdef1234567890"))).toBeUndefined();

		const clearWrites = writeSpy.mock.calls.map((c: unknown[]) => c[0]).filter((s: unknown) => s === "\r");
		expect(clearWrites.length).toBe(1);
	});
});

describe("index-cmd — update command (elapsed arithmetic)", () => {
	// Vitest spy handles carry awkward overloaded generics.
	let logSpy: any;
	// Vitest spy handles carry awkward overloaded generics.
	let dateSpy: any;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	afterEach(() => {
		logSpy.mockRestore();
		dateSpy?.mockRestore();
		vi.mocked(TrigramIndex.load).mockReset();
	});

	it("P4: elapsed seconds use (now-start)/1000, not *1000 or now+start", async () => {
		const saveMock = vi.fn();
		const index = new TrigramIndex([], new Map(), new Set(), "1111111122222222", "/repo");
		vi.spyOn(index, "incrementalUpdate").mockReturnValue(5);
		vi.spyOn(index, "save").mockImplementation(saveMock);
		vi.mocked(TrigramIndex.load).mockReturnValue(index);

		// startTime=1000, elapsed calc now=4000 => (4000-1000)/1000 = 3.0
		dateSpy = vi.spyOn(Date, "now").mockImplementation(dateNowSequence([1000, 4000]));

		const program = buildProgram();
		await run(program, ["update"]);

		const logs = logLines(logSpy);
		expect(logs).toContain("Updated 5 files in 3.0s");
	});
});

describe("index-cmd — status command (meta text lines, optional chaining, freshness boundaries)", () => {
	let tmpDir: string;
	// Vitest spy handles carry awkward overloaded generics.
	let logSpy: any;
	// Vitest spy handles carry awkward overloaded generics.
	let dateSpy: any;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "index-cmd-w42-"));
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	afterEach(() => {
		logSpy.mockRestore();
		dateSpy?.mockRestore();
		vi.mocked(TrigramIndex.loadMeta).mockReset();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("P5: meta text lines render exact field values (trigrams/stop-grams/index-size/base-commit) and undefined avgNextMaskBits does not throw", async () => {
		const { avgNextMaskBits: _avgNextMaskBits, ...meta } = new TrigramIndex([], new Map(), new Set(), "", "/repo").stats();
		vi.mocked(TrigramIndex.loadMeta).mockReturnValue({
			...meta,
			fileCount: 100,
			trigramCount: 200,
			stopTrigramCount: 30,
			indexSizeBytes: 2048,
			baseCommit: "1234567890abcdef",
			builtAt: "2026-01-01T00:00:00Z",
			avgLocMaskBits: 5.2,
		});

		const program = buildProgram();
		await run(program, ["status", "--cwd", tmpDir]);

		const logs = logLines(logSpy);
		expect(logs).toContain("  Trigrams:    200");
		expect(logs).toContain("  Stop grams:  30");
		expect(logs).toContain("  Index size:  2.0 KB");
		expect(logs).toContain("  Base commit: 12345678");
		expect(logs.find((l) => l.includes("1234567890abcdef"))).toBeUndefined();
		expect(logs).toContain("  Avg nextMask: undefined bits/entry");
	});

	it("N1: freshness section is absent when meta is null (no crash, no leftover text)", async () => {
		vi.mocked(TrigramIndex.loadMeta).mockReturnValue(null);
		const program = buildProgram();
		await run(program, ["status", "--cwd", tmpDir]);
		const logs = logLines(logSpy);
		expect(logs).toContain("No trigram index found.");
	});

	it("P6: freshness at exactly 1 minute reads '1min ago' — kills the <1 boundary AND the index-path string mutants", async () => {
		vi.mocked(TrigramIndex.loadMeta).mockReturnValue({
			fileCount: 1,
			trigramCount: 1,
			stopTrigramCount: 0,
			indexSizeBytes: 1,
			baseCommit: "abcdef1234567890",
			builtAt: "2026-01-01T00:00:00Z",
		});

		const indexDir = join(tmpDir, ".interlinked", "index");
		mkdirSync(indexDir, { recursive: true });
		const filePath = join(indexDir, "trigram.lookup");
		writeFileSync(filePath, "x");
		const fileMtime = statSync(filePath).mtimeMs;

		// Deliberately give the directory a wildly different mtime so that if a
		// path-segment mutant makes indexPath resolve to the directory instead
		// of the file, the freshness text is dramatically different (not "1min ago").
		const dirOldMs = fileMtime - 100 * 60 * 60 * 1000; // 100 hours before the file
		utimesSync(indexDir, new Date(dirOldMs), new Date(dirOldMs));
		utimesSync(filePath, new Date(fileMtime), new Date(fileMtime));
		expect(existsSync(filePath)).toBe(true);

		const fixedNow = fileMtime + 60000; // exactly 1 minute after the file's mtime
		dateSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);

		const program = buildProgram();
		await run(program, ["status", "--cwd", tmpDir]);

		const logs = logLines(logSpy);
		expect(logs).toContain("  Freshness:   1min ago");
		expect(logs.find((l) => l.includes("just built"))).toBeUndefined();
	});

	it("P7: freshness at exactly 60 minutes reads '1h ago', not '60min ago'", async () => {
		vi.mocked(TrigramIndex.loadMeta).mockReturnValue({
			fileCount: 1,
			trigramCount: 1,
			stopTrigramCount: 0,
			indexSizeBytes: 1,
			baseCommit: "abcdef1234567890",
			builtAt: "2026-01-01T00:00:00Z",
		});

		const indexDir = join(tmpDir, ".interlinked", "index");
		mkdirSync(indexDir, { recursive: true });
		const filePath = join(indexDir, "trigram.lookup");
		writeFileSync(filePath, "x");
		const fileMtime = statSync(filePath).mtimeMs;
		utimesSync(filePath, new Date(fileMtime), new Date(fileMtime));

		const fixedNow = fileMtime + 60 * 60000; // exactly 60 minutes after the file's mtime
		dateSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);

		const program = buildProgram();
		await run(program, ["status", "--cwd", tmpDir]);

		const logs = logLines(logSpy);
		expect(logs).toContain("  Freshness:   1h ago");
		expect(logs.find((l) => l.includes("60min ago"))).toBeUndefined();
	});
});

describe("index-cmd — query command (candidate truncation boundary)", () => {
	// Vitest spy handles carry awkward overloaded generics.
	let logSpy: any;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	afterEach(() => {
		logSpy.mockRestore();
		vi.mocked(TrigramIndex.load).mockReset();
		vi.mocked(decomposePattern).mockReset();
	});

	it("P8: exactly 50 candidates prints all 50 with no '...and N more' suffix", async () => {
		const files = Array.from({ length: 50 }, (_, i) => `file-${i}.ts`);
		const index = new TrigramIndex(Array.from({ length: 100 }, (_, i) => `file-${i}.ts`), new Map(), new Set(), "", "/repo");
		vi.spyOn(index, "queryCandidatePaths").mockReturnValue(files);
		vi.mocked(TrigramIndex.load).mockReturnValue(index);
		vi.mocked(decomposePattern).mockReturnValue({
			hasLiterals: true,
			requiredTrigrams: [0x616263], literalSegments: ["abc"], isLiteral: true, trigramSequences: [[0x616263]],
		});

		const program = buildProgram();
		await run(program, ["query", "abc"]);

		const logs = logLines(logSpy);
		expect(logs.find((l) => l.includes("more"))).toBeUndefined();
		expect(logs).toContain("  file-49.ts");
	});
});
