import { parseWire, wireArray, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
// Mutation-hardening companion to `search.integration.test.ts`.
//
// Each `it()` below targets one or more specific mutants that survived a
// Stryker run against `search.ts` (boundary conditions, malformed rg --json
// shapes, and exact-argv/exact-options assertions the broader integration
// suite didn't pin down precisely enough to fail under the mutated
// semantics). Where one crafted input kills several listed mutants at once
// (e.g. a compound `||` condition collapsing to the same observable outcome
// under three different mutations), a single test covers all of them and
// says so in a comment.
//
// Mocking strategy mirrors `search.integration.test.ts` exactly: mock the
// two I/O boundaries (`node:child_process`, `node:fs`) plus `../lib/output.js`
// and `../lib/formatter.js` so output is deterministic; `node:path` and
// `./search-query.js` are left real. Every test here uses `{ json: true }`
// so assertions read the exact structured result rather than rendered text.

import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================
// Mocks (identical setup to search.integration.test.ts)
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

// Imported after the mocks are declared so the SUT binds to them.
import { searchCommand } from "./search.js";

// ===========================================
// Test helpers (mirrors search.integration.test.ts)
// ===========================================

let logSpy: ReturnType<typeof vi.spyOn>;
let nowValue: number;

function spawnResult(over: Partial<SpawnSyncReturns<Buffer>>): SpawnSyncReturns<Buffer> {
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
	return JSON.stringify({
		type: "match",
		data: {
			path: { text: path },
			line_number: lineNumber,
			lines: { text: `${text}\n` },
			submatches: [{ start: 0 }],
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

function loggedJson(): Record<string, unknown> {
	return parseWire(JSON.parse(logged()), wireRecord(wireUnknown), "test JSON value");
}

/** Find the rg *search* invocation (not the `--version` probe) among all spawnSync calls. */
function findSearchCall(): [string, string[], unknown] | undefined {
	const call = mockSpawnSync.mock.calls.find(
		(cl) => (parseWire(cl[1], wireOptional(wireArray(wireString)), "test JSON value"))?.[0] === "--json",
	);
	if (!call) return undefined;
	return [parseWire(call[0], wireString, "spawn binary"), parseWire(call[1], wireArray(wireString), "spawn arguments"), call[2]];
}

/** Find the rg `--version` probe call among all spawnSync calls. */
function findVersionCall(): [string, string[], unknown] | undefined {
	const call = mockSpawnSync.mock.calls.find(
		(cl) => (parseWire(cl[1], wireOptional(wireArray(wireString)), "test JSON value"))?.[0] === "--version",
	);
	if (!call) return undefined;
	return [parseWire(call[0], wireString, "spawn binary"), parseWire(call[1], wireArray(wireString), "spawn arguments"), call[2]];
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
			size: isFile ? (nonNull(files[p])).length : 0,
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
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	// Deterministic clock: each call advances 5ms.
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
// hasRipgrep: exact probe invocation
// ===========================================

describe("hasRipgrep — exact subprocess invocation", () => {
	it("probes with the literal command \"rg\" and argv [\"--version\"]", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const versionCall = findVersionCall();
		expect(versionCall?.[0]).toBe("rg");
		expect(versionCall?.[1]).toEqual(["--version"]);
	});

	it("probes with the exact { stdio: \"pipe\", timeout: 3000 } options", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const versionCall = findVersionCall();
		expect(versionCall?.[2]).toEqual({ stdio: "pipe", timeout: 3000 });
	});
});

// ===========================================
// searchWithRipgrep: exact subprocess invocation
// ===========================================

describe("searchWithRipgrep — exact subprocess invocation", () => {
	it("invokes the search subprocess as the literal command \"rg\"", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		expect(findSearchCall()?.[0]).toBe("rg");
	});

	it("builds the exact argv shape: flags, dashes, query, dir", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true, limit: "5" });
		const argv = nonNull(findSearchCall()?.[1]);
		// limit(5)*2 = "10"; default context = "2"; no --glob/--type since
		// neither option was passed.
		expect(argv).toEqual([
			"--json",
			"--max-count",
			"10",
			"-C",
			"2",
			"--smart-case",
			"--",
			"needle",
			"/repo",
		]);
	});

	it("omits --glob and --type entirely when neither option is passed", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const argv = nonNull(findSearchCall()?.[1]);
		expect(argv).not.toContain("--glob");
		expect(argv).not.toContain("--type");
	});

	it("invokes the search subprocess with the exact stdio/timeout/maxBuffer options", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const opts = findSearchCall()?.[2];
		expect(opts).toEqual({ stdio: "pipe", timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
	});

	it("computes elapsed_ms as (now - start), not (now + start), across repeated calls", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true }); // start=0 here; not diagnostic on its own
		logSpy.mockClear();
		searchCommand("needle", { json: true }); // start is now non-zero (10)
		expect(loggedJson().elapsed_ms).toBe(5);
	});

	it("does not flag truncated when matches exactly equal the limit", () => {
		const lines = [1, 2, 3].map((n) => rgMatch("/repo/a.ts", n, "needle"));
		lines.push(rgSummary(1));
		withRipgrep(lines.join("\n"));
		searchCommand("needle", { json: true, limit: "3" });
		const out = loggedJson();
		expect(out.truncated).toBe(false);
		expect(out).toHaveProperty(["matches","length"], 3);
	});
});

// ===========================================
// rg --json boundary parsers: malformed shapes that must not crash
// ===========================================

describe("rg --json boundary parsers — malformed shapes are skipped, not thrown", () => {
	it("a match line whose data.path is JSON null is skipped", () => {
		const badMatch = JSON.stringify({
			type: "match",
			data: { path: null, line_number: 1, lines: { text: "needle\n" } },
		});
		withRipgrep(`${badMatch}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(0);
	});

	it("a match line whose data is JSON null is skipped", () => {
		const badMatch = JSON.stringify({ type: "match", data: null });
		withRipgrep(`${badMatch}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(0);
	});

	// Kills three mutants at once: with lines.text a non-string but lines
	// itself a valid object, forcing the whole `!isJsonObject(lines) ||
	// typeof lines.text !== "string"` condition false, swapping the `||` for
	// `&&`, and forcing just the `typeof` half false all produce the exact
	// same wrong outcome here (the line is not skipped).
	it("a match line whose lines.text is a non-string is skipped", () => {
		const badMatch = JSON.stringify({
			type: "match",
			data: { path: { text: "/repo/a.ts" }, line_number: 1, lines: { text: 42 } },
		});
		withRipgrep(`${badMatch}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(0);
	});

	it("a match line with no submatches field yields an undefined column, not a crash", () => {
		const noSubmatches = JSON.stringify({
			type: "match",
			data: { path: { text: "/repo/a.ts" }, line_number: 1, lines: { text: "needle\n" } },
		});
		withRipgrep(`${noSubmatches}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.column).toBeUndefined();
	});

	it("a context line whose data is JSON null is skipped", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({ type: "context", data: null }),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(1);
	});

	it("a context line whose path text is missing does not crash the relative() call", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({
				type: "context",
				data: { path: {}, line_number: 5, lines: { text: "ctx\n" } },
			}),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(1);
	});

	// Kills two mutants: forcing the whole `||` condition false, and forcing
	// just the `typeof lines.text !== "string"` half false, both leave a
	// non-string context text unblocked here (lines itself is a valid object).
	it("a context line whose lines.text is a non-string is skipped", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({
				type: "context",
				data: { path: { text: "/repo/a.ts" }, line_number: 2, lines: { text: 42 } },
			}),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out.total).toBe(1);
		const matches = parseWire(out.matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches[0]?.context_after).toEqual([]);
	});

	it("a summary line whose data is JSON null defaults searched_files to 0", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({ type: "summary", data: null }),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().searched_files).toBe(0);
	});

	it("a bare JSON null line is skipped like an unrecognized value, not thrown", () => {
		const stdout = ["null", rgMatch("/repo/a.ts", 1, "needle"), rgSummary(1)].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().total).toBe(1);
	});

	it("a context line with a non-numeric line_number contributes to no match's context", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 1, "first needle"),
			JSON.stringify({
				type: "context",
				data: { path: { text: "/repo/a.ts" }, line_number: "5", lines: { text: "bogus\n" } },
			}),
			rgMatch("/repo/a.ts", 10, "second needle"),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(2);
		expect(matches[0]?.context_after).toEqual([]);
		expect(matches[1]?.context_before).toBeUndefined();
	});

	it("an unrecognized message type after a summary does not reset searched_files", () => {
		const stdout = [
			rgSummary(5),
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({ type: "end", data: {} }),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		expect(loggedJson().searched_files).toBe(5);
	});
});

// ===========================================
// searchWithRipgrep: text stripping (exact, not "first newline anywhere")
// ===========================================

describe("searchWithRipgrep — trailing-newline stripping is anchored", () => {
	it("strips only the trailing newline from match text, preserving an embedded one", () => {
		const embeddedMatch = JSON.stringify({
			type: "match",
			data: { path: { text: "/repo/a.ts" }, line_number: 1, lines: { text: "foo\nbar\n" } },
		});
		withRipgrep(`${embeddedMatch}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches[0]?.text).toBe("foo\nbar");
	});

	it("strips only the trailing newline from context text, preserving an embedded one", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 1, "needle"),
			JSON.stringify({
				type: "context",
				data: { path: { text: "/repo/a.ts" }, line_number: 2, lines: { text: "ctxfoo\nctxbar\n" } },
			}),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches[0]?.context_after).toEqual(["ctxfoo\nctxbar"]);
	});
});

// ===========================================
// searchWithRipgrep: context-attachment boundaries
// ===========================================

describe("searchWithRipgrep — context attachment boundaries", () => {
	it("omits context_before (not an empty array) when no leading context is pending", () => {
		withRipgrep(`${rgMatch("/repo/a.ts", 1, "needle")}\n${rgSummary(1)}`);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches[0]?.context_before).toBeUndefined();
	});

	it("does not attach context from a different file as trailing context on the prior match", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 5, "needle"),
			rgContext("/repo/b.ts", 6, "line from a different file"),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.context_after).toEqual([]);
	});

	it("does not attach a context line whose line number equals the match's own line", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 5, "needle"),
			rgContext("/repo/a.ts", 5, "same-line noise"),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches[0]?.context_after).toEqual([]);
	});

	it("attaches trailing context exactly at the boundary line (last.line + context)", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 5, "needle"),
			rgContext("/repo/a.ts", 7, "right at the edge"), // 5 + context(2) = 7
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true, context: "2" });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches[0]?.context_after).toEqual(["right at the edge"]);
	});

	it("accumulates multiple trailing context lines without dropping earlier ones", () => {
		const stdout = [
			rgMatch("/repo/a.ts", 5, "needle"),
			rgContext("/repo/a.ts", 6, "first after"),
			rgContext("/repo/a.ts", 7, "second after"),
			rgSummary(1),
		].join("\n");
		withRipgrep(stdout);
		searchCommand("needle", { json: true, context: "2" });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches[0]?.context_after).toEqual(["first after", "second after"]);
	});
});

// ===========================================
// collectFiles: dot-entry / SKIP_DIRS boundaries
// ===========================================

describe("collectFiles — dot-entry and SKIP_DIRS boundaries", () => {
	it("skips a hidden (dot-prefixed) directory that is not on the SKIP_DIRS list", () => {
		withNativeTree(
			{ "/repo": [".secret", "normal.ts"], "/repo/.secret": ["inner.ts"] },
			{ "/repo/.secret/inner.ts": "needle", "/repo/normal.ts": "unrelated" },
		);
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out.total).toBe(0);
		expect(out.searched_files).toBe(1);
	});

	it("does not special-case a literal '.' entry as distinct from other dot-entries", () => {
		withoutRipgrep();
		let repoListCalls = 0;
		mockReaddirSync.mockImplementation((p: string) => {
			if (p === "/repo") {
				repoListCalls++;
				return repoListCalls === 1 ? ["."] : [];
			}
			return [];
		});
		mockStatSync.mockImplementation((p: string) => ({
			isDirectory: () => p === "/repo",
			isFile: () => false,
			size: 0,
		}));
		searchCommand("needle", { json: true });
		// The "." entry resolves (via path.join) back to "/repo" itself; the
		// source's `entry !== "."` carve-out means it is NOT treated as a
		// dot-file to skip, so collectFiles recurses into "/repo" once more,
		// listing it a second time.
		expect(repoListCalls).toBe(2);
	});

	it("does not treat a non-file, non-directory entry as a searchable file", () => {
		withoutRipgrep();
		mockReaddirSync.mockImplementation((p: string) => (p === "/repo" ? ["weird.ts", "ok.ts"] : []));
		mockStatSync.mockImplementation((p: string) => {
			if (p === "/repo/weird.ts") return { isDirectory: () => false, isFile: () => false, size: 10 };
			return { isDirectory: () => false, isFile: () => true, size: 10 };
		});
		mockReadFileSync.mockImplementation((p: string) =>
			p === "/repo/weird.ts" ? "needle-in-weird" : "needle",
		);
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out.searched_files).toBe(1);
		const matches = parseWire(out.matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches.every((m) => m.file !== "weird.ts")).toBe(true);
	});

	it("excludes a file exactly at the 1MB size boundary (strict less-than)", () => {
		withoutRipgrep();
		mockReaddirSync.mockImplementation((p: string) => (p === "/repo" ? ["big.ts"] : []));
		mockStatSync.mockReturnValue({ isDirectory: () => false, isFile: () => true, size: 1024 * 1024 });
		mockReadFileSync.mockReturnValue("needle");
		searchCommand("needle", { json: true });
		expect(loggedJson().searched_files).toBe(0);
	});

	const NON_DOT_SKIP_DIRS = [
		"dist",
		"build",
		"__pycache__",
		"venv",
		"target",
		"coverage",
		"playwright-report",
	];
	it.each(NON_DOT_SKIP_DIRS)("skips the %s directory entirely (not just via the dot rule)", (dirName: string) => {
		withNativeTree(
			{ "/repo": [dirName, "keep.ts"], [`/repo/${dirName}`]: ["inner.ts"] },
			{ [`/repo/${dirName}/inner.ts`]: "needle", "/repo/keep.ts": "unrelated" },
		);
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out.total).toBe(0);
		expect(out.searched_files).toBe(1);
	});
});

// ===========================================
// SEARCHABLE_EXTENSIONS: exhaustive per-extension coverage
// ===========================================

describe("collectFiles — SEARCHABLE_EXTENSIONS (exhaustive)", () => {
	const EXTENSIONS = [
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs",
		".py",
		".rs",
		".go",
		".java",
		".cpp",
		".c",
		".h",
		".md",
		".json",
		".txt",
		".yml",
		".yaml",
		".toml",
		".sh",
		".bash",
		".zsh",
		".sql",
		".html",
		".css",
		".svelte",
		".vue",
		".rb",
		".php",
		".swift",
		".kt",
	];

	it.each(EXTENSIONS)("indexes and finds a match in a %s file", (ext: string) => {
		const fname = `file${ext}`;
		withNativeTree({ "/repo": [fname] }, { [`/repo/${fname}`]: "needle" });
		searchCommand("needle", { json: true });
		const out = loggedJson();
		expect(out.searched_files).toBe(1);
		expect(out.total).toBe(1);
	});
});

// ===========================================
// searchWithNative: exact I/O + boundaries
// ===========================================

describe("searchWithNative — exact I/O and boundaries", () => {
	it("reads files with utf-8 encoding explicitly", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "needle" });
		searchCommand("needle", { json: true });
		expect(mockReadFileSync).toHaveBeenCalledWith("/repo/a.ts", "utf-8");
		// Not just a call-shape check: confirm the encoded read actually
		// produced a usable match, not an empty/garbled result.
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toBe("needle");
	});

	it("case-insensitive smart-case search matches every casing (gi flags)", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "MIXED\nmixed\nMiXeD" });
		searchCommand("mixed", { json: true });
		expect(loggedJson().total).toBe(3);
	});

	it("omits context_before (not an empty array) for a match on the file's first line", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "needle\nafter1\nafter2" });
		searchCommand("needle", { json: true, context: "2" });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches[0]?.context_before).toBeUndefined();
	});

	it("omits context_after (not an empty array) for a match on the file's last line", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "before1\nbefore2\nneedle" });
		searchCommand("needle", { json: true, context: "2" });
		const matches = parseWire(loggedJson().matches, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(matches[0]?.context_after).toBeUndefined();
	});

	it("stops scanning once matches reach limit*2, across files (early-fetch cap)", () => {
		const fiveNeedles = Array.from({ length: 5 }, () => "needle").join("\n");
		withNativeTree(
			{ "/repo": ["a.ts", "b.ts"] },
			{ "/repo/a.ts": fiveNeedles, "/repo/b.ts": "needle" },
		);
		searchCommand("needle", { json: true, limit: "2" }); // threshold = limit*2 = 4
		const out = loggedJson();
		// a.ts alone offers 5 matches; the early-fetch cap must stop scanning
		// (both within a.ts's remaining lines and before ever reaching b.ts)
		// at exactly 4, not 5 and not 1 (which a wrong /-arithmetic would give).
		expect(out.total).toBe(4);
	});

	it("computes elapsed_ms as (now - start), not (now + start), across repeated calls", () => {
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": "needle" });
		searchCommand("needle", { json: true });
		logSpy.mockClear();
		searchCommand("needle", { json: true });
		expect(loggedJson().elapsed_ms).toBe(5);
	});

	it("does not flag truncated when matches exactly equal the limit", () => {
		const content = ["needle", "needle", "needle"].join("\n");
		withNativeTree({ "/repo": ["a.ts"] }, { "/repo/a.ts": content });
		searchCommand("needle", { json: true, limit: "3" });
		const out = loggedJson();
		expect(out.truncated).toBe(false);
		expect(out).toHaveProperty(["matches","length"], 3);
	});
});
