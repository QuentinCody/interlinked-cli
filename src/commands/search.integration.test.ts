import { parseWire, wireArray, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// Behavioral tests for `interlinked search` — the local codebase search
// command. The command picks a search engine (ripgrep when `rg --version`
// exits 0, native fs walk otherwise), splits natural-language queries into
// an OR pattern, ranks files by term density for multi-term queries, and
// renders in json / short / normal / full modes.
//
// Strategy: mock the two I/O boundaries (`node:child_process` for the rg
// subprocess + version probe, `node:fs` for the native directory walk) plus
// the two `../lib/*` presentation modules so output is deterministic and
// assertable. `node:path` is left real. `performance.now` is mocked to a
// fixed monotonic clock so `elapsed_ms` strings are exact. console.log /
// console.error are spied; `outputError` sets `process.exitCode = 1`, so we
// assert the code rather than a thrown `process.exit`.

import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================
// Mocks
// ===========================================

const mockSpawnSync = vi.fn();
vi.mock("node:child_process", () => ({
	spawnSync: (cmd: string, args: string[], opts: unknown) => mockSpawnSync(cmd, args, opts),
}));

const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock("node:fs", () => ({
	readdirSync: (p: string) => mockReaddirSync(p),
	readFileSync: (p: string, enc: string) => mockReadFileSync(p, enc),
	statSync: (p: string) => mockStatSync(p),
}));

// Identity color helpers + predictable header/truncate so we can assert on
// plain strings (no ANSI). truncate mirrors the real "append … past maxLen".
vi.mock("../lib/formatter.js", () => {
	const identity = (s: string) => s;
	return {
		c: {
			bold: identity,
			dim: identity,
			italic: identity,
			red: identity,
			green: identity,
			yellow: identity,
			blue: identity,
			magenta: identity,
			cyan: identity,
			gray: identity,
			white: identity,
		},
		header: (title: string) => `HEADER(${title})`,
		truncate: (text: string, maxLen: number) =>
			text.length <= maxLen ? text : `${text.slice(0, Math.max(0, maxLen - 1))}…`,
	};
});

// Faithful re-implementation of the output module: keeps the source's
// branch-by-mode logic intact while routing through console for assertions.
vi.mock("../lib/output.js", () => ({
	getOutputMode: (o: { json?: boolean; short?: boolean; full?: boolean }) => {
		if (o.json) return "json";
		if (o.short) return "short";
		if (o.full) return "full";
		return "normal";
	},
	output: (
		mode: string,
		data: unknown,
		renderers: {
			json?: () => unknown;
			short?: () => string;
			normal: () => string;
			full?: () => string;
		},
	) => {
		switch (mode) {
			case "json":
				console.log(JSON.stringify(renderers.json ? renderers.json() : data, null, 2));
				break;
			case "short":
				console.log(renderers.short ? renderers.short() : renderers.normal());
				break;
			case "full":
				console.log(renderers.full ? renderers.full() : renderers.normal());
				break;
			default:
				console.log(renderers.normal());
		}
	},
	outputError: (mode: string, message: string, details?: unknown) => {
		if (mode === "json") {
			console.error(JSON.stringify({ error: message, details }, null, 2));
		} else {
			console.error(`Error: ${message}`);
		}
		process.exitCode = 1;
	},
}));

import { nonNull } from "../lib/non-null.js";
// Imported after the mocks are declared so the SUT binds to them.
import { searchCommand } from "./search.js";

// ===========================================
// Test helpers
// ===========================================

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let nowValue: number;

function spawnResult(over: Partial<SpawnSyncReturns<Buffer | null>>): SpawnSyncReturns<Buffer | null> {
	return {
		pid: 1,
		output: [],
		stdout: Buffer.from(""),
		stderr: Buffer.from(""),
		status: 0,
		signal: null,
		...over,
	};
}

/** First spawnSync call is the `rg --version` probe; route by argv[0]. */
function withRipgrep(rgStdout: string): void {
	mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
		if (args[0] === "--version") return spawnResult({ status: 0 });
		return spawnResult({ stdout: Buffer.from(rgStdout, "utf-8"), status: 0 });
	});
}

/** Make `rg --version` fail so the command falls back to native fs. */
function withoutRipgrep(): void {
	mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
		if (args[0] === "--version") return spawnResult({ status: 127 });
		return spawnResult({ status: 1 });
	});
}

/** rg --json line for a single match. */
function rgMatch(path: string, lineNumber: number, text: string): string {
	return rgMatchAt({ path, lineNumber, text, col: 0 });
}

/** rg --json match line with an explicit submatch column. */
function rgMatchAt(m: { path: string; lineNumber: number; text: string; col: number }): string {
	return JSON.stringify({
		type: "match",
		data: {
			path: { text: m.path },
			line_number: m.lineNumber,
			lines: { text: `${m.text}\n` },
			submatches: [{ start: m.col }],
		},
	});
}

/** rg --json context line. */
function rgContext(path: string, lineNumber: number, text: string): string {
	return JSON.stringify({
		type: "context",
		data: { path: { text: path }, line_number: lineNumber, lines: { text: `${text}\n` } },
	});
}

/** rg --json summary line carrying searched-file count. */
function rgSummary(searches: number): string {
	return JSON.stringify({ type: "summary", data: { stats: { searches } } });
}

function callsToString(spy: ReturnType<typeof vi.spyOn>): string {
	const calls = spy.mock.calls;
	return calls.map((call: unknown[]) => call.map((arg: unknown) => String(arg)).join(" ")).join("\n");
}

function logged(): string {
	return callsToString(logSpy);
}

function errored(): string {
	return callsToString(errSpy);
}

function loggedJson(): Record<string, unknown> {
	return parseWire(JSON.parse(logged()), wireRecord(wireUnknown), "test JSON value");
}

/**
 * Wire the native fs walk: `tree` maps a directory path to its entries;
 * `files` maps a file path to its content. Anything in `files` is a regular
 * file (~10 bytes); anything in `tree` is a directory. CWD is "/repo".
 */
function withNativeTree(tree: Record<string, string[]>, files: Record<string, string>): void {
	withoutRipgrep();
	mockReaddirSync.mockImplementation((p: string) => tree[p] ?? []);
	mockStatSync.mockImplementation((p: string) => {
		const isDir = Object.prototype.hasOwnProperty.call(tree, p);
		const isFile = Object.prototype.hasOwnProperty.call(files, p);
		if (!isDir && !isFile) throw new Error(`ENOENT ${p}`);
		return {
			isDirectory: () => isDir,
			isFile: () => isFile,
			size: isFile ? nonNull(files[p]).length : 0,
		};
	});
	mockReadFileSync.mockImplementation((p: string) => {
		if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
		throw new Error(`ENOENT ${p}`);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	// Deterministic clock: each call advances 5ms, so the first measured span
	// (now - start) is exactly 5 → "5ms" in rendered output.
	nowValue = 0;
	vi.spyOn(performance, "now").mockImplementation(() => {
		const v = nowValue;
		nowValue += 5;
		return v;
	});
	vi.spyOn(process, "cwd").mockReturnValue("/repo");
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

// ===========================================
// Input validation
// ===========================================

describe("searchCommand — input validation", () => {
	it("empty query errors and sets exit code 1 (normal mode)", () => {
		searchCommand("", {});
		expect(errored()).toContain("Error: Search query is required");
		expect(process.exitCode).toBe(1);
		// spawnSync must never run — we bailed before engine selection.
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});

	it("whitespace-only query is treated as empty", () => {
		searchCommand("   \t  ", {});
		expect(errored()).toContain("Search query is required");
		expect(process.exitCode).toBe(1);
	});

	it("missing query in json mode emits a structured error object", () => {
		searchCommand("", { json: true });
		const payload = parseWire(JSON.parse(errored()), wireRecord(wireUnknown), "test JSON value");
		expect(payload.error).toBe("Search query is required");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// Engine selection
// ===========================================

describe("searchCommand — engine selection", () => {
	it("--engine=ripgrep with rg absent errors and aborts", () => {
		withoutRipgrep();
		searchCommand("needle", { engine: "ripgrep" });
		expect(errored()).toContain("ripgrep (rg) not found");
		expect(process.exitCode).toBe(1);
	});

	it("--engine=native skips the rg version probe entirely", () => {
		withNativeTree({ "/repo": [] }, {});
		searchCommand("needle", { engine: "native", json: true });
		// Native path never probes `rg --version`.
		const versionProbes = mockSpawnSync.mock.calls.filter(
			(cl) => (parseWire(cl[1], wireOptional(wireArray(wireString)), "test JSON value"))?.[0] === "--version",
		);
		expect(versionProbes).toHaveLength(0);
		expect(loggedJson().engine).toBe("native");
	});

	it("falls back to native when rg is unavailable (default engine)", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "needle here" });
		searchCommand("needle", { json: true });
		expect(loggedJson().engine).toBe("native");
	});

	it("uses ripgrep when available (default engine)", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 3, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		expect(loggedJson().engine).toBe("ripgrep");
	});
});

// ===========================================
// Ripgrep engine + JSON parsing
// ===========================================

describe("searchCommand — ripgrep engine", () => {
	it("relativizes the match path against the search dir", () => {
		withRipgrep(
			`${rgMatchAt({ path: "/repo/src/a.ts", lineNumber: 12, text: "x", col: 0 })}\n${rgSummary(4)}`,
		);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(nonNull(matches[0]).file).toBe("src/a.ts");
	});

	it("extracts the match line number", () => {
		withRipgrep(
			`${rgMatchAt({ path: "/repo/a.ts", lineNumber: 12, text: "x", col: 0 })}\n${rgSummary(1)}`,
		);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(nonNull(matches[0]).line).toBe(12);
	});

	it("extracts the submatch column from the first submatch", () => {
		withRipgrep(
			`${rgMatchAt({ path: "/repo/a.ts", lineNumber: 1, text: "const needle = 1", col: 6 })}\n${rgSummary(1)}`,
		);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(nonNull(matches[0]).column).toBe(6);
	});

	it("strips the trailing newline from the match text", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "const needle = 1")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(nonNull(matches[0]).text).toBe("const needle = 1");
	});

	it("reports the engine, total, and searched-file count", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(4)}`);
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out.engine).toBe("ripgrep");
		expect(out.total).toBe(1);
		expect(out.searched_files).toBe(4);
	});

	it("overrides the display query with the human-readable original", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		expect(loggedJson().query).toBe("needle");
	});

	it("passes --glob and --type through to the rg argv", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "x")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true, glob: "*.ts", type: "ts" });
		const rgCall = mockSpawnSync.mock.calls.find(
			(cl) => (parseWire(cl[1], wireOptional(wireArray(wireString)), "test JSON value"))?.[0] === "--json",
		);
		expect(rgCall).toBeDefined();
		const argv = parseWire(rgCall?.[1], wireArray(wireString), "test JSON value");
		expect(argv).toContain("--glob");
		expect(argv).toContain("*.ts");
		expect(argv).toContain("--type");
		expect(argv).toContain("ts");
	});

	it("attaches leading context to the following match (context_before)", () => {
		const stdout = [
			rgContext("/repo/a.ts", 1, "line before"),
			rgMatch("/repo/a.ts", 2, "the needle"),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true, context: "2" });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(nonNull(matches[0]).context_before).toEqual(["line before"]);
	});

	it("attaches trailing context to the preceding match (context_after)", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 5, "the needle"),
			rgContext("/repo/a.ts", 6, "line after"),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true, context: "2" });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(nonNull(matches[0]).context_after).toEqual(["line after"]);
	});

	it("treats context beyond the window (or a different file) as leading for the next match", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 5, "needle one"),
			// gap > context window (line 20 vs match line 5, context default 2)
			rgContext("/repo/a.ts", 20, "far context"),
			rgMatch("/repo/a.ts", 21, "needle two"),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		// The far context becomes leading context for the second match, not
		// trailing on the first.
		expect(nonNull(matches[0]).context_after).toEqual([]);
		expect(nonNull(matches[1]).context_before).toEqual(["far context"]);
	});

	it("skips malformed JSON lines without throwing", () => {
		const stdout = ["this is not json {{{", rgMatch("/repo/a.ts", 1, "needle"), rgSummary(1)].join(
			"\n",
		);
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(1);
	});

	it("missing summary stats default searched_files to 0", () => {
		// summary line present but stats omitted → `|| 0` branch.
		const stdout = [
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({ type: "summary", data: {} }),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().searched_files).toBe(0);
	});

	it("empty rg stdout yields zero matches", () => {
		withRipgrep("");
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out.total).toBe(0);
		expect(out.matches).toEqual([]);
	});

	it("null rg stdout (no output buffer) yields zero matches", () => {
		// Exercises the `if (result.stdout)` false branch.
		mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "--version") return spawnResult({ status: 0 });
			return spawnResult({ stdout: null, status: 1 });
		});
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out.total).toBe(0);
		expect(out.searched_files).toBe(0);
	});

	it("ignores rg JSON objects of an unrecognized type", () => {
		// `begin`/`end` events fall through all the type branches harmlessly.
		const stdout = [
			JSON.stringify({ type: "begin", data: { path: { text: "/repo/a.ts" } } }),
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({ type: "end", data: {} }),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(1);
	});

	it("truncates when matches exceed the limit and flags truncated=true", () => {
		const lines: string[] = [];
		for (let i = 1; i <= 5; i++) lines.push(rgMatch("/repo/a.ts", i, "needle"));
		lines.push(rgSummary(1));
		withRipgrep(lines.join("\n"));
		searchCommand("needle", { json: true, limit: "2" });
		const out = loggedJson();
		expect(out.truncated).toBe(true);
		expect(out.total).toBe(5);
		expect(out).toHaveProperty(["matches","length"], 2);
	});
});

// ===========================================
// rg --json message boundary parsers
// (parseRipgrepMatch / parseRipgrepContext / parseRipgrepSearchedFiles)
// ===========================================

describe("searchCommand — rg --json message boundary parsers", () => {
	it("P1: a well-formed match line yields file/line/column/text (positive control)", () => {
		withRipgrep(
			`${rgMatchAt({ path: "/repo/a.ts", lineNumber: 4, text: "needle", col: 2 })}\n${rgSummary(1)}`,
		);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(4);
		expect(nonNull(matches[0]).column).toBe(2);
	});

	it("N1: a match line whose data.line_number is a string (not a number) is skipped", () => {
		const badMatch = JSON.stringify({
			type: "match",
			data: { path: { text: "/repo/a.ts" }, line_number: "4", lines: { text: "needle\n" } },
		});
		withRipgrep(`${badMatch}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(0);
	});

	it("N2: a match line whose data.path.text is missing is skipped", () => {
		const badMatch = JSON.stringify({
			type: "match",
			data: { path: {}, line_number: 1, lines: { text: "needle\n" } },
		});
		withRipgrep(`${badMatch}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(0);
	});

	it("N3: a context line with a non-object data.lines is skipped, not attached and not thrown", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({
				type: "context",
				data: { path: { text: "/repo/a.ts" }, line_number: 2, lines: "not-an-object" },
			}),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).context_after).toEqual([]);
	});

	it("N4: a summary line whose data.stats.searches is a string falls back to 0", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({ type: "summary", data: { stats: { searches: "lots" } } }),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().searched_files).toBe(0);
	});

	it("P2: a non-numeric submatch start is treated as absent (column undefined, not thrown)", () => {
		const badSubmatch = JSON.stringify({
			type: "match",
			data: {
				path: { text: "/repo/a.ts" },
				line_number: 1,
				lines: { text: "needle\n" },
				submatches: [{ start: "not-a-number" }],
			},
		});
		withRipgrep(`${badSubmatch}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).column).toBeUndefined();
	});

	it("N5: a bare-JSON-primitive line (e.g. `true`) is skipped like an unrecognized type", () => {
		const stdout = ["true", rgMatch("/repo/a.ts", 1, "needle"), rgSummary(1)].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(1);
	});
});

// ===========================================
// Native fs engine
// ===========================================

describe("searchCommand — native engine", () => {
	it("walks the tree, reads files, finds matches with 1-based line numbers", () => {
		withNativeTree(
			{ "/repo": ["src"], "/repo/src": ["a.ts", "b.ts"] },
			{
				"/repo/src/a.ts": "no match here\nfound the needle\nlast",
				"/repo/src/b.ts": "irrelevant",
			},
		);
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out.engine).toBe("native");
		expect(out.searched_files).toBe(2);
		const matches = parseWire(out.matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).file).toBe("src/a.ts");
		expect(nonNull(matches[0]).line).toBe(2);
		expect(nonNull(matches[0]).text).toBe("found the needle");
	});

	it("attaches before/after context windows from the file", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "l1\nl2\nNEEDLE\nl4\nl5" });
		searchCommand("NEEDLE", { json: true, context: "1" });
		const m = (parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value"))[0];
		expect(nonNull(m).context_before).toEqual(["l2"]);
		expect(nonNull(m).context_after).toEqual(["l4"]);
	});

	it("skips SKIP_DIRS, dotfiles, non-searchable extensions, and oversized files", () => {
		withNativeTree(
			{
				"/repo": ["node_modules", ".hidden", "big.ts", "img.png", "ok.ts"],
				"/repo/node_modules": ["evil.ts"],
			},
			{
				"/repo/node_modules/evil.ts": "needle",
				"/repo/big.ts": "x".repeat(2 * 1024 * 1024), // > 1MB → skipped
				"/repo/img.png": "needle", // non-searchable ext
				"/repo/ok.ts": "needle",
			},
		);
		searchCommand("needle", { json: true });
		const out = loggedJson();
		// Only ok.ts is eligible and searched.
		expect(out.searched_files).toBe(1);
		const matches = parseWire(out.matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).file).toBe("ok.ts");
	});

	it("recovers when readdirSync throws (unreadable directory)", () => {
		withoutRipgrep();
		mockReaddirSync.mockImplementation((p: string) => {
			if (p === "/repo") return ["sub"];
			throw new Error("EACCES");
		});
		mockStatSync.mockImplementation((p: string) => ({
			isDirectory: () => p === "/repo/sub",
			isFile: () => false,
			size: 0,
		}));
		searchCommand("needle", { json: true });
		// No crash; the unreadable subdir contributes nothing.
		expect(loggedJson().total).toBe(0);
	});

	it("recovers when statSync throws for an entry", () => {
		withoutRipgrep();
		mockReaddirSync.mockImplementation((p: string) => (p === "/repo" ? ["a.ts", "b.ts"] : []));
		mockStatSync.mockImplementation((p: string) => {
			if (p === "/repo/a.ts") throw new Error("ELOOP");
			return { isDirectory: () => false, isFile: () => true, size: 10 };
		});
		mockReadFileSync.mockReturnValue("needle");
		searchCommand("needle", { json: true });
		// a.ts stat threw and was skipped; b.ts searched.
		expect(loggedJson().searched_files).toBe(1);
	});

	it("recovers when readFileSync throws (unreadable file)", () => {
		withoutRipgrep();
		mockReaddirSync.mockImplementation((p: string) => (p === "/repo" ? ["a.ts"] : []));
		mockStatSync.mockReturnValue({ isDirectory: () => false, isFile: () => true, size: 10 });
		mockReadFileSync.mockImplementation(() => {
			throw new Error("EIO");
		});
		searchCommand("needle", { json: true });
		// searchedFiles increments before the read, then the read fails → 0 matches.
		const out = loggedJson();
		expect(out.searched_files).toBe(1);
		expect(out.total).toBe(0);
	});

	it("applies the native glob filter, excluding non-matching paths", () => {
		withNativeTree(
			{ "/repo": ["a.ts", "b.md"] },
			{ "/repo/a.ts": "needle", "/repo/b.md": "needle" },
		);
		searchCommand("needle", { json: true, glob: "*.ts" });
		const out = loggedJson();
		// Only a.ts passes the *.ts glob.
		expect(out.searched_files).toBe(1);
		expect(nonNull((parseWire(out.matches, wireArray(wireRecord(wireUnknown)), "test JSON value"))[0]).file).toBe("a.ts");
	});

	it("native truncates to the limit and flags truncated", () => {
		const content = Array.from({ length: 6 }, () => "needle").join("\n");
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": content });
		searchCommand("needle", { json: true, limit: "2" });
		const out = loggedJson();
		expect(out.truncated).toBe(true);
		expect(out).toHaveProperty(["matches","length"], 2);
	});

	it("case-sensitive when query has uppercase (smart case off)", () => {
		// Query "Needle" is not all-lowercase → regex without `i` flag.
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "needle\nNeedle" });
		searchCommand("Needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toBe("Needle");
	});

	it("case-insensitive when query is all lowercase (smart case on)", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "NEEDLE\nneedle" });
		searchCommand("needle", { json: true });
		// Single-term lowercase → matches both casings.
		expect(loggedJson().total).toBe(2);
	});

	it("escapes regex metacharacters in a single-term query", () => {
		// "a.c" must match the literal "a.c", not "abc".
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "abc\na.c" });
		searchCommand("a.c", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toBe("a.c");
	});

	it("compiles a query with regex metacharacters without throwing", () => {
		// escapeRegex neutralizes the trailing ++ so the literal is found safely.
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "value++\nplain" });
		searchCommand("value++", { json: true });
		expect(loggedJson().total).toBe(1);
	});

	it("falls back to an escaped regex when the raw OR pattern is invalid", () => {
		// "a(|b" sanitizes to one term ("ab") → single-term path passes the raw
		// query through. It contains "|" (no "\\|") so isOrPattern is true and
		// the raw "a(|b" is compiled directly → SyntaxError → catch re-compiles
		// the escaped literal, which matches the literal text "a(|b".
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "a(|b\nunrelated" });
		searchCommand("a(|b", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toBe("a(|b");
	});

	it("ignores a directory entry that is neither a file nor a directory", () => {
		// A socket/fifo: isDirectory() and isFile() both false → skipped.
		withoutRipgrep();
		mockReaddirSync.mockImplementation((p: string) => (p === "/repo" ? ["sock", "ok.ts"] : []));
		mockStatSync.mockImplementation((p: string) => ({
			isDirectory: () => false,
			isFile: () => p === "/repo/ok.ts",
			size: 10,
		}));
		mockReadFileSync.mockReturnValue("needle");
		searchCommand("needle", { json: true });
		const out = loggedJson();
		// Only the real file is searched; the special entry is ignored.
		expect(out.searched_files).toBe(1);
		expect(nonNull((parseWire(out.matches, wireArray(wireRecord(wireUnknown)), "test JSON value"))[0]).file).toBe("ok.ts");
	});
});

// ===========================================
// Multi-term queries + ranking
// ===========================================

describe("searchCommand — multi-term queries", () => {
	it("builds an OR pattern and ranks files by term density", () => {
		// Two real terms after stop-word filtering: "oauth", "token".
		withNativeTree(
			{ "/repo": ["both.ts", "one.ts"] },
			{
				"/repo/both.ts": "oauth here\ntoken there",
				"/repo/one.ts": "just oauth",
			},
		);
		searchCommand("oauth token", { json: true });
		const out = loggedJson();
		const rankings = parseWire(out.rankings, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(rankings).toBeDefined();
		// both.ts matches 2 terms → ranked above one.ts (1 term).
		expect(nonNull(rankings[0]).file).toBe("both.ts");
		expect(nonNull(rankings[0]).termsMatched).toBe(2);
		expect(nonNull(rankings[0]).totalTerms).toBe(2);
		expect(nonNull(rankings[0]).matchedTerms).toEqual(["oauth", "token"]);
		expect(nonNull(rankings[1]).file).toBe("one.ts");
		expect(nonNull(rankings[1]).termsMatched).toBe(1);
	});

	it("filters stop words so a query reduces to a single term (no ranking)", () => {
		// "the value" → only "value" survives → single-term, rankings undefined.
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "value" });
		searchCommand("the value", { json: true });
		const out = loggedJson();
		expect(out.rankings ?? null).toBeNull();
		expect(out.query).toBe("the value");
	});

	it("ranking is omitted when a multi-term query finds nothing", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "unrelated content" });
		searchCommand("oauth token", { json: true });
		const out = loggedJson();
		expect(out.total).toBe(0);
		expect(out.rankings ?? null).toBeNull();
	});

	it("ripgrep multi-term: display query stays the human phrase, rankings present", () => {
		withRipgrep(
			[
				rgMatch("/repo/a.ts", 1, "oauth and token"),
				rgMatch("/repo/a.ts", 2, "more oauth"),
				rgSummary(1),
			].join("\n"),
		);
		searchCommand("oauth token", { json: true });
		const out = loggedJson();
		expect(out.query).toBe("oauth token");
		expect(out.rankings).toBeDefined();
		expect(nonNull((parseWire(out.rankings, wireArray(wireRecord(wireUnknown)), "test JSON value"))[0]).termsMatched).toBe(2);
	});
});

// ===========================================
// Output modes
// ===========================================

describe("searchCommand — output modes", () => {
	it("short mode: 'No matches' when nothing found", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "unrelated" });
		searchCommand("needle", { short: true });
		expect(logged()).toBe("No matches");
	});

	it("short mode: pluralized summary line with engine + timing", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "needle\nneedle" });
		searchCommand("needle", { short: true });
		// Two matches, lowercase query so both casings — exactly 2 here.
		expect(logged()).toBe("2 matches in 1 files (native, 5ms)");
	});

	it("short mode: singular 'match' for exactly one result", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "needle\nother" });
		searchCommand("needle", { short: true });
		expect(logged()).toBe("1 match in 1 files (native, 5ms)");
	});

	it("normal mode: no-matches renders the header + 'No matches found.'", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "unrelated" });
		searchCommand("needle", {});
		const out = logged();
		expect(out).toContain('HEADER(Search: "needle")');
		expect(out).toContain("native · 0 matches · 1 files · 5ms");
		expect(out).toContain("No matches found.");
	});

	it("normal mode: groups matches by file with padded line numbers", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "needle one\nx\nneedle two" });
		searchCommand("needle", {});
		const out = logged();
		expect(out).toContain("a.ts");
		expect(out).toContain("1: needle one");
		expect(out).toContain("3: needle two");
	});

	it("normal mode: truncation footer shows the remaining-match count", () => {
		const content = Array.from({ length: 5 }, (_, i) => `needle ${i}`).join("\n");
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": content });
		searchCommand("needle", { limit: "2" });
		const out = logged();
		// Native over-fetches to limit*2 (=4) before trimming to 2, so the
		// footer reports total(4) - shown(2) = "2 more matches".
		expect(out).toContain("… 2 more matches (use --limit to see more)");
	});

	it("normal mode: multi-term renders the 'Most relevant files' summary", () => {
		withNativeTree({ "/repo": ["both.ts"] }, { "/repo/both.ts": "oauth line\ntoken line" });
		searchCommand("oauth token", {});
		const out = logged();
		expect(out).toContain("Most relevant files:");
		// 2/2 terms = 100% (high band), listing the matched terms.
		expect(out).toContain("100%");
		expect(out).toContain("[oauth, token]");
	});

	it("full mode: renders match locations with > marker and context lines", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "before\nNEEDLE\nafter" });
		searchCommand("NEEDLE", { full: true, context: "1" });
		const out = logged();
		expect(out).toContain("a.ts:2");
		expect(out).toContain("> NEEDLE");
		expect(out).toContain("before");
		expect(out).toContain("after");
	});

	it("full mode: multi-term renders the ranking summary above matches", () => {
		// Exercises the rankings branch inside renderFull.
		withNativeTree({ "/repo": ["both.ts"] }, { "/repo/both.ts": "oauth line\ntoken line" });
		searchCommand("oauth token", { full: true });
		const out = logged();
		expect(out).toContain("Most relevant files:");
		expect(out).toContain("> oauth line");
		expect(out).toContain("> token line");
	});

	it("normal mode: skips a ranked file whose matches were trimmed by the limit", () => {
		// Two files match; one term apiece plus a shared term so both rank, but a
		// tiny limit trims one file's matches out of the displayed set. The
		// renderNormal byFile loop pre-seeds every ranked file then `continue`s
		// over the one left with zero displayed matches.
		const aLines = Array.from({ length: 3 }, () => "alpha beta").join("\n");
		withNativeTree(
			{ "/repo": ["aaa.ts", "zzz.ts"] },
			{ "/repo/aaa.ts": aLines, "/repo/zzz.ts": "alpha beta" },
		);
		searchCommand("alpha beta", { limit: "1" });
		const out = logged();
		// aaa.ts (more matches) sorts first and consumes the single display slot;
		// zzz.ts is ranked but contributes no displayed match line.
		expect(out).toContain("Most relevant files:");
		expect(out).toContain("aaa.ts");
		// zzz.ts appears in the ranking summary but not as a match-body header
		// with line content beneath it.
		const body = out.slice(out.lastIndexOf("]") + 1);
		expect(body).not.toMatch(/zzz\.ts\n\s+\d+:/);
	});

	it("full mode: no-matches path renders 'No matches found.'", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "unrelated" });
		searchCommand("needle", { full: true });
		expect(logged()).toContain("No matches found.");
	});

	it("full mode: truncation footer present when results exceed the limit", () => {
		const content = Array.from({ length: 4 }, () => "needle").join("\n");
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": content });
		searchCommand("needle", { full: true, limit: "1" });
		expect(logged()).toContain("more matches (use --limit to see more)");
	});

	it("json mode: emits the full result object including rankings key", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "needle" });
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out).toHaveProperty("query", "needle");
		expect(out).toHaveProperty("engine", "native");
		expect(out).toHaveProperty("matches");
		expect(out).toHaveProperty("elapsed_ms");
		// single-term → rankings omitted (undefined drops out of JSON.stringify)
		expect(out).not.toHaveProperty("rankings");
	});
});

// ===========================================
// Option parsing (limit / context clamping, path)
// ===========================================

describe("searchCommand — option parsing", () => {
	it("clamps limit above MAX_LIMIT (200)", () => {
		// 250 matches available, limit requested 999 → clamped to 200.
		const lines: string[] = [];
		for (let i = 1; i <= 250; i++) lines.push(rgMatch("/repo/a.ts", i, "needle"));
		lines.push(rgSummary(1));
		withRipgrep(lines.join("\n"));
		searchCommand("needle", { json: true, limit: "999" });
		const out = loggedJson();
		expect(out).toHaveProperty(["matches","length"], 200);
		expect(out.truncated).toBe(true);
	});

	it("non-numeric limit falls back to the default (30)", () => {
		const lines: string[] = [];
		for (let i = 1; i <= 40; i++) lines.push(rgMatch("/repo/a.ts", i, "needle"));
		lines.push(rgSummary(1));
		withRipgrep(lines.join("\n"));
		searchCommand("needle", { json: true, limit: "not-a-number" });
		expect(loggedJson()).toHaveProperty(["matches","length"], 30);
	});

	it("limit below 1 clamps up to 1", () => {
		// A negative limit parses truthy (-5), so it bypasses the `|| DEFAULT`
		// fallback and exercises the Math.max(1, …) lower clamp → 1.
		const lines = [
			rgMatch("/repo/a.ts", 1, "needle"),
			rgMatch("/repo/a.ts", 2, "needle"),
			rgSummary(1),
		];
		withRipgrep(lines.join("\n"));
		searchCommand("needle", { json: true, limit: "-5" });
		expect(loggedJson()).toHaveProperty(["matches","length"], 1);
	});

	it("limit of literal '0' parses falsy and falls back to the default", () => {
		// parseInt("0") === 0 is falsy → `|| DEFAULT_LIMIT` selects 30, not 1.
		const lines: string[] = [];
		for (let i = 1; i <= 40; i++) lines.push(rgMatch("/repo/a.ts", i, "needle"));
		lines.push(rgSummary(1));
		withRipgrep(lines.join("\n"));
		searchCommand("needle", { json: true, limit: "0" });
		expect(loggedJson()).toHaveProperty(["matches","length"], 30);
	});

	it("context is clamped to a max of 10 and passed to rg -C", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true, context: "999" });
		const rgCall = mockSpawnSync.mock.calls.find(
			(cl) => (parseWire(cl[1], wireOptional(wireArray(wireString)), "test JSON value"))?.[0] === "--json",
		);
		const argv = parseWire(rgCall?.[1], wireArray(wireString), "test JSON value");
		const cIdx = argv.indexOf("-C");
		expect(argv[cIdx + 1]).toBe("10");
	});

	it("non-numeric context falls back to the default (2)", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true, context: "abc" });
		const rgCall = mockSpawnSync.mock.calls.find(
			(cl) => (parseWire(cl[1], wireOptional(wireArray(wireString)), "test JSON value"))?.[0] === "--json",
		);
		const argv = parseWire(rgCall?.[1], wireArray(wireString), "test JSON value");
		const cIdx = argv.indexOf("-C");
		expect(argv[cIdx + 1]).toBe("2");
	});

	it("honors --path for the search directory (rg argv ends with that dir)", () => {
		withRipgrep(`${rgMatch("/somewhere/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true, path: "/somewhere" });
		const rgCall = mockSpawnSync.mock.calls.find(
			(cl) => (parseWire(cl[1], wireOptional(wireArray(wireString)), "test JSON value"))?.[0] === "--json",
		);
		const argv = parseWire(rgCall?.[1], wireArray(wireString), "test JSON value");
		expect(argv[argv.length - 1]).toBe("/somewhere");
		// relative() against the path dir resolves the file cleanly.
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(nonNull(matches[0]).file).toBe("a.ts");
	});

	it("defaults the search directory to process.cwd() when --path is absent", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const rgCall = mockSpawnSync.mock.calls.find(
			(cl) => (parseWire(cl[1], wireOptional(wireArray(wireString)), "test JSON value"))?.[0] === "--json",
		);
		const argv = parseWire(rgCall?.[1], wireArray(wireString), "test JSON value");
		expect(argv[argv.length - 1]).toBe("/repo");
	});
});

// ===========================================
// Ranking color bands (renderRankingSummary)
// ===========================================

describe("searchCommand — ranking color bands", () => {
	// Drive the three pct branches (>=75 green, >=50 yellow, <50 dim) via the
	// fraction of terms a file matches. Colors are identity-mocked, so we
	// assert on the percentage label + matched-terms list instead.
	it("medium band (50%): a file matching half the terms", () => {
		// Four terms: alpha beta gamma delta. File matches exactly two → 50%.
		withNativeTree({ "/repo": ["half.ts"] }, { "/repo/half.ts": "alpha beta only" });
		searchCommand("alpha beta gamma delta", {});
		const out = logged();
		expect(out).toContain("Most relevant files:");
		expect(out).toContain("50%");
		expect(out).toContain("[alpha, beta]");
	});

	it("low band (<50%): a file matching one of four terms", () => {
		withNativeTree({ "/repo": ["low.ts"] }, { "/repo/low.ts": "alpha only" });
		searchCommand("alpha beta gamma delta", {});
		const out = logged();
		expect(out).toContain("25%");
		expect(out).toContain("[alpha]");
	});

	it("caps the ranking summary at the top 10 files", () => {
		// 12 files, each matching both terms → only 10 listed in the summary.
		const tree: Record<string, string[]> = { "/repo": [] };
		const files: Record<string, string> = {};
		for (let i = 0; i < 12; i++) {
			const name = `f${i}.ts`;
			nonNull(tree["/repo"]).push(name);
			files[`/repo/${name}`] = "oauth token";
		}
		withNativeTree(tree, files);
		searchCommand("oauth token", {});
		const out = logged();
		const summaryRegion = out.slice(out.indexOf("Most relevant files:"));
		// The ranking summary block (first ~12 lines after the heading) lists at
		// most 10 distinct files.
		const inSummaryBlock = summaryRegion.split("\n").slice(0, 12).join("\n");
		const summaryFiles = (inSummaryBlock.match(/\bf\d+\.ts\b/g) ?? []).filter(
			(v, i, a) => a.indexOf(v) === i,
		);
		expect(summaryFiles.length).toBe(10);
	});
});
