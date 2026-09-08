import { parseWire, wireRecord, wireUnknown } from "../lib/value-validation.js";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { registerIndexCommand } from "./index-cmd.js";

// ===========================================
// Behavioral tests for `interlinked index`
// ===========================================
// registerIndexCommand wires four subcommands (build / update / status /
// query) onto a commander program. We mock the harness TrigramIndex (and
// the dynamically-imported regex decomposer + node:fs used by the freshness
// branch), then drive each subcommand through commander's parseAsync and
// assert on the captured stdout, exit codes, and the side-effects the
// actions trigger on the mocked index (save / incrementalUpdate / query).

// --- Hoisted mock state (vi.mock factories run before module init) ---
const h = vi.hoisted(() => {
	return {
		// Static method mocks
		build: vi.fn(),
		load: vi.fn(),
		loadMeta: vi.fn(),
		// Instance method mocks (reset per test)
		save: vi.fn(),
		stats: vi.fn(),
		incrementalUpdate: vi.fn(),
		queryCandidatePaths: vi.fn(),
		// regex decomposer
		decomposePattern: vi.fn(),
		// node:fs
		existsSync: vi.fn(),
		statSync: vi.fn(),
	};
});

vi.mock("../harness/trigram-index.js", () => ({
	TrigramIndex: {
		build: h.build,
		load: h.load,
		loadMeta: h.loadMeta,
	},
}));

vi.mock("../harness/regex-trigrams.js", () => ({
	decomposePattern: h.decomposePattern,
}));

vi.mock("node:fs", () => ({
	existsSync: h.existsSync,
	statSync: h.statSync,
}));

// --- IO capture (console.log + process.stdout.write + exit code) ---
interface Captured {
	stdout: string;
	exitCode: string | number | undefined;
}

function captureIO(): { get: () => Captured; restore: () => void } {
	let stdout = "";
	const origExit = process.exitCode;
	process.exitCode = undefined;
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		stdout += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
	});
	const writeSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
	return {
		get: () => ({ stdout, exitCode: process.exitCode }),
		restore: () => {
			logSpy.mockRestore();
			writeSpy.mockRestore();
			process.exitCode = origExit;
		},
	};
}

// Build a fresh commander program with the index command attached.
function newProgram(): Command {
	const program = new Command();
	program.exitOverride(); // throw instead of process.exit on parse errors
	registerIndexCommand(program);
	return program;
}

// Run `interlinked index <args...>` through commander.
async function runIndex(...args: string[]): Promise<void> {
	await newProgram().parseAsync(["index", ...args], { from: "user" });
}

// A fake index instance returned by build()/load(). Wires the shared
// instance-method spies so assertions can inspect calls.
function fakeIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		baseCommit: "abcdef1234567890",
		totalFiles: 100,
		save: h.save,
		stats: h.stats,
		incrementalUpdate: h.incrementalUpdate,
		queryCandidatePaths: h.queryCandidatePaths,
		...overrides,
	};
}

const fullStats = {
	fileCount: 1234,
	trigramCount: 56789,
	stopTrigramCount: 42,
	baseCommit: "deadbeefcafef00d",
	indexSizeBytes: 2_500_000,
	builtAt: "2026-06-06T00:00:00.000Z",
};

let io: ReturnType<typeof captureIO>;

beforeEach(() => {
	vi.clearAllMocks();
	io = captureIO();
	// Freeze time so elapsed/age formatting is deterministic.
	vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
});

afterEach(() => {
	io.restore();
	vi.restoreAllMocks();
});

// ===========================================
// registration smoke
// ===========================================
describe("registerIndexCommand", () => {
	it("is a function and registers an `index` command with four subcommands", () => {
		expect(typeof registerIndexCommand).toBe("function");
		const program = newProgram();
		const indexCmd = program.commands.find((c) => c.name() === "index");
		expect(indexCmd).toBeDefined();
		const subNames = (nonNull(indexCmd)).commands.map((c) => c.name()).sort();
		expect(subNames).toEqual(["build", "query", "status", "update"]);
	});
});

// ===========================================
// build
// ===========================================
describe("index build", () => {
	it("builds, saves, and prints formatted stats (MB branch + toLocaleString)", async () => {
		h.stats.mockReturnValue(fullStats);
		h.build.mockReturnValue(fakeIndex());

		await runIndex("build", "--cwd", "/repo");

		// Build was invoked with parsed numeric options.
		expect(h.build).toHaveBeenCalledTimes(1);
		const buildArgs = parseWire(nonNull(h.build.mock.calls[0])[0], wireRecord(wireUnknown), "test JSON value");
		expect(buildArgs.cwd).toContain("/repo");
		expect(buildArgs.maxFileSize).toBe(1_048_576); // default parsed via parseInt
		expect(buildArgs.stopThreshold).toBe(0.4); // default parsed via parseFloat
		expect(typeof buildArgs.onProgress).toBe("function");

		// Index saved to the .interlinked dir under cwd.
		expect(h.save).toHaveBeenCalledTimes(1);
		expect(String(nonNull(h.save.mock.calls[0])[0])).toContain(".interlinked");

		const { stdout } = io.get();
		expect(stdout).toContain("Building trigram index for");
		expect(stdout).toContain("Index built in");
		expect(stdout).toContain("Files:       1,234"); // toLocaleString
		expect(stdout).toContain("Trigrams:    56,789");
		expect(stdout).toContain("Stop grams:  42");
		expect(stdout).toContain("Index size:  2.4 MB"); // MB branch of formatBytes
		expect(stdout).toContain("Base commit: deadbeef"); // sliced to 8
	});

	it("respects --max-file-size and --stop-threshold overrides", async () => {
		h.stats.mockReturnValue(fullStats);
		h.build.mockReturnValue(fakeIndex());

		await runIndex(
			"build",
			"--cwd",
			"/repo",
			"--max-file-size",
			"2048",
			"--stop-threshold",
			"0.25",
		);

		const buildArgs = parseWire(nonNull(h.build.mock.calls[0])[0], wireRecord(wireUnknown), "test JSON value");
		expect(buildArgs.maxFileSize).toBe(2048);
		expect(buildArgs.stopThreshold).toBe(0.25);
	});

	it("formatBytes covers B and KB branches via the index size line", async () => {
		// KB branch (>= 1024 and < 1MB)
		h.stats.mockReturnValue({ ...fullStats, indexSizeBytes: 2048 });
		h.build.mockReturnValue(fakeIndex());
		await runIndex("build", "--cwd", "/repo");
		expect(io.get().stdout).toContain("Index size:  2.0 KB");
	});

	it("formatBytes covers the raw-bytes (B) branch", async () => {
		h.stats.mockReturnValue({ ...fullStats, indexSizeBytes: 512 });
		h.build.mockReturnValue(fakeIndex());
		await runIndex("build", "--cwd", "/repo");
		expect(io.get().stdout).toContain("Index size:  512 B");
	});

	it("onProgress writes a progress line only after the 500ms throttle window", async () => {
		h.stats.mockReturnValue(fullStats);
		// Capture the onProgress callback. The real TrigramIndex.build invokes
		// it synchronously while indexing; here we capture it and drive it with
		// controlled clock values to exercise both sides of the 500ms throttle.
		let progress: ((indexed: number, total: number) => void) | undefined;
		const nowSpy = vi.mocked(Date.now);
		h.build.mockImplementation((opts: { onProgress?: (i: number, t: number) => void }) => {
			progress = opts.onProgress;
			// First tick: lastReport starts at 0, so 600 - 0 > 500 → writes.
			nowSpy.mockReturnValue(600);
			(nonNull(opts.onProgress))(3, 10);
			// Second tick 200ms later: 800 - 600 = 200 < 500 → suppressed.
			nowSpy.mockReturnValue(800);
			(nonNull(opts.onProgress))(4, 10);
			// Third tick well past the window: 2000 - 600 > 500 → writes again.
			nowSpy.mockReturnValue(2000);
			(nonNull(opts.onProgress))(5, 10);
			return fakeIndex();
		});

		await runIndex("build", "--cwd", "/repo");

		expect(progress).toBeTypeOf("function");
		const { stdout } = io.get();
		expect(stdout).toContain("Indexing... 3/10 files");
		expect(stdout).not.toContain("Indexing... 4/10 files"); // throttled
		expect(stdout).toContain("Indexing... 5/10 files");
	});
});

// ===========================================
// update
// ===========================================
describe("index update", () => {
	it("errors with exit code 1 when no existing index is found", async () => {
		h.load.mockReturnValue(null);

		await runIndex("update", "--cwd", "/repo");

		expect(io.get().exitCode).toBe(1);
		expect(io.get().stdout).toContain("No existing index found");
		expect(io.get().stdout).toContain("interlinked index build");
		expect(h.incrementalUpdate).not.toHaveBeenCalled();
	});

	it("reports up-to-date and does not save when incrementalUpdate returns 0", async () => {
		h.incrementalUpdate.mockReturnValue(0);
		h.load.mockReturnValue(fakeIndex());

		await runIndex("update", "--cwd", "/repo");

		expect(io.get().stdout).toContain("Updating index (base: abcdef12)"); // sliced commit
		expect(io.get().stdout).toContain("Index is up to date");
		expect(h.save).not.toHaveBeenCalled();
		expect(io.get().exitCode).toBeUndefined();
	});

	it("saves and reports the updated file count when changes are found", async () => {
		h.incrementalUpdate.mockReturnValue(7);
		h.load.mockReturnValue(fakeIndex());

		await runIndex("update", "--cwd", "/repo");

		expect(h.save).toHaveBeenCalledTimes(1);
		expect(String(nonNull(h.save.mock.calls[0])[0])).toContain(".interlinked");
		expect(io.get().stdout).toMatch(/Updated 7 files in [\d.]+s/);
	});
});

// ===========================================
// status
// ===========================================
describe("index status", () => {
	it("prints a human 'not found' message when no meta exists", async () => {
		h.loadMeta.mockReturnValue(null);

		await runIndex("status", "--cwd", "/repo");

		const { stdout } = io.get();
		expect(stdout).toContain("No trigram index found.");
		expect(stdout).toContain("interlinked index build");
	});

	it("prints JSON {exists:false} when no meta exists and --json is set", async () => {
		h.loadMeta.mockReturnValue(null);

		await runIndex("status", "--cwd", "/repo", "--json");

		expect(io.get().stdout.trim()).toBe(JSON.stringify({ exists: false }));
	});

	it("prints full JSON with exists:true when --json is set and meta exists", async () => {
		h.loadMeta.mockReturnValue(fullStats);

		await runIndex("status", "--cwd", "/repo", "--json");

		const parsed = JSON.parse(io.get().stdout);
		expect(parsed).toMatchObject({ exists: true, ...fullStats });
		// fs freshness branch must NOT run in JSON mode.
		expect(h.existsSync).not.toHaveBeenCalled();
	});

	it("prints the human table without optional breakdown lines and shows 'just built' freshness", async () => {
		h.loadMeta.mockReturnValue(fullStats); // no optional fields
		h.existsSync.mockReturnValue(true);
		// mtime now → age < 1 minute
		h.statSync.mockReturnValue({ mtimeMs: 1_000_000_000_000 });

		await runIndex("status", "--cwd", "/repo");

		const { stdout } = io.get();
		expect(stdout).toContain("Trigram Search Index");
		expect(stdout).toContain("Files:       1,234");
		expect(stdout).toContain("Built at:    2026-06-06T00:00:00.000Z");
		expect(stdout).toContain("Freshness:   just built");
		// Optional sections omitted.
		expect(stdout).not.toContain("Avg locMask");
		expect(stdout).not.toContain("Lookup file");
	});

	it("prints the optional locMask / nextMask + lookup/postings breakdown lines when present", async () => {
		h.loadMeta.mockReturnValue({
			...fullStats,
			avgLocMaskBits: 12.34,
			avgNextMaskBits: 5.67,
			lookupSizeBytes: 4096,
			postingsSizeBytes: 8192,
		});
		h.existsSync.mockReturnValue(false); // skip freshness block

		await runIndex("status", "--cwd", "/repo");

		const { stdout } = io.get();
		expect(stdout).toContain("Avg locMask:  12.3 bits/entry"); // toFixed(1)
		expect(stdout).toContain("Avg nextMask: 5.7 bits/entry");
		expect(stdout).toContain("Lookup file:  4.0 KB");
		expect(stdout).toContain("Postings:     8.0 KB");
		// existsSync(false) means no freshness line.
		expect(stdout).not.toContain("Freshness:");
	});

	it("falls back to 0 B postings when postingsSizeBytes is missing (?? branch)", async () => {
		h.loadMeta.mockReturnValue({
			...fullStats,
			lookupSizeBytes: 1000,
			// postingsSizeBytes intentionally absent
		});
		h.existsSync.mockReturnValue(false);

		await runIndex("status", "--cwd", "/repo");

		expect(io.get().stdout).toContain("Postings:     0 B");
	});

	it("formats freshness in minutes when 1 <= age < 60", async () => {
		h.loadMeta.mockReturnValue(fullStats);
		h.existsSync.mockReturnValue(true);
		// 5 minutes ago: now - mtime = 5 * 60000
		h.statSync.mockReturnValue({ mtimeMs: 1_000_000_000_000 - 5 * 60_000 });

		await runIndex("status", "--cwd", "/repo");

		expect(io.get().stdout).toContain("Freshness:   5min ago");
	});

	it("formats freshness in hours when age >= 60 minutes", async () => {
		h.loadMeta.mockReturnValue(fullStats);
		h.existsSync.mockReturnValue(true);
		// 3 hours ago
		h.statSync.mockReturnValue({ mtimeMs: 1_000_000_000_000 - 3 * 60 * 60_000 });

		await runIndex("status", "--cwd", "/repo");

		expect(io.get().stdout).toContain("Freshness:   3h ago");
	});
});

// ===========================================
// query
// ===========================================
describe("index query", () => {
	it("errors with exit code 1 when no index is found", async () => {
		h.load.mockReturnValue(null);

		await runIndex("query", "foo", "--cwd", "/repo");

		expect(io.get().exitCode).toBe(1);
		expect(io.get().stdout).toContain("No index found");
		expect(h.decomposePattern).not.toHaveBeenCalled();
	});

	it("reports when the pattern yields no extractable trigrams", async () => {
		h.load.mockReturnValue(fakeIndex());
		h.decomposePattern.mockReturnValue({ requiredTrigrams: [], hasLiterals: false });

		await runIndex("query", "x", "--cwd", "/repo");

		expect(io.get().stdout).toContain("No extractable trigrams from pattern.");
		expect(h.queryCandidatePaths).not.toHaveBeenCalled();
	});

	it("reports 'No matching files.' when there are literals but zero candidates", async () => {
		h.load.mockReturnValue(fakeIndex({ totalFiles: 100 }));
		h.decomposePattern.mockReturnValue({ requiredTrigrams: [1, 2, 3], hasLiterals: true });
		h.queryCandidatePaths.mockReturnValue([]);

		await runIndex("query", "needle", "--cwd", "/repo");

		const { stdout } = io.get();
		expect(stdout).toContain("Pattern: needle → 3 trigrams, 0/100 candidate files");
		expect(stdout).toContain("No matching files.");
		// decomposePattern called with regex=false (the default).
		expect(h.decomposePattern).toHaveBeenCalledWith("needle", false);
	});

	it("lists candidate paths and passes --regex through to the decomposer", async () => {
		h.load.mockReturnValue(fakeIndex({ totalFiles: 5 }));
		h.decomposePattern.mockReturnValue({ requiredTrigrams: [10, 20], hasLiterals: true });
		h.queryCandidatePaths.mockReturnValue(["src/a.ts", "src/b.ts"]);

		await runIndex("query", "ab.*c", "--cwd", "/repo", "--regex");

		const { stdout } = io.get();
		expect(stdout).toContain("Pattern: ab.*c → 2 trigrams, 2/5 candidate files");
		expect(stdout).toContain("  src/a.ts");
		expect(stdout).toContain("  src/b.ts");
		expect(stdout).not.toContain("more");
		expect(h.decomposePattern).toHaveBeenCalledWith("ab.*c", true);
		expect(h.queryCandidatePaths).toHaveBeenCalledWith([10, 20]);
	});

	it("truncates to the first 50 candidates and reports the remainder", async () => {
		const many = Array.from({ length: 73 }, (_, i) => `src/file-${i}.ts`);
		h.load.mockReturnValue(fakeIndex({ totalFiles: 73 }));
		h.decomposePattern.mockReturnValue({ requiredTrigrams: [7], hasLiterals: true });
		h.queryCandidatePaths.mockReturnValue(many);

		await runIndex("query", "common", "--cwd", "/repo");

		const { stdout } = io.get();
		expect(stdout).toContain("  src/file-0.ts");
		expect(stdout).toContain("  src/file-49.ts"); // last of the first 50
		expect(stdout).not.toContain("  src/file-50.ts"); // beyond the slice
		expect(stdout).toContain("... and 23 more"); // 73 - 50
	});
});
