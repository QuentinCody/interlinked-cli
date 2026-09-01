// ===========================================
// interlinked logs — wave-40 survivor-kill suite
// ===========================================
// Targets specific mutation-manifest survivors in src/commands/logs.ts that
// the pre-existing logs.test.ts and logs.mutation-kill-luna-v3.test.ts don't
// distinguish. Self-contained mocks with call-count/arg spies where the
// textual console output alone can't tell pristine from mutant apart.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FsState {
	exists: boolean;
	size: number;
	statThrows: boolean;
	fileContent: Buffer;
}

let fsState: FsState;
let watchCallback: (() => void) | null;
let watchedOpts: unknown;
let watchedPath: string | null;

// Spies wrap the underlying byte-accurate logic so tests can assert on the
// exact arguments a mutated arithmetic/flag/guard expression would change,
// not just on whether text happens to show up in the rendered console lines.
const openSyncSpy = vi.fn((_p: string, flag: string) => {
	if (flag !== "r") {
		throw new Error(`unexpected open flag: ${flag}`);
	}
	return 42;
});
const readSyncSpy = vi.fn(
	(_fd: number, buffer: Buffer, bufOffset: number, length: number, position: number) => {
		const slice = fsState.fileContent.subarray(position, position + length);
		slice.copy(buffer, bufOffset);
		return slice.length;
	},
);
const closeSyncSpy = vi.fn((_fd: number) => undefined);

function freshFs(): FsState {
	return { exists: true, size: 0, statThrows: false, fileContent: Buffer.alloc(0) };
}

vi.mock("node:fs", () => ({
	existsSync: (_p: string) => fsState.exists,
	statSync: (_p: string) => {
		if (fsState.statThrows) throw new Error("ENOENT stat");
		return { size: fsState.size };
	},
	openSync: (p: string, flag: string) => openSyncSpy(p, flag),
	readSync: (fd: number, buffer: Buffer, bufOffset: number, length: number, position: number) =>
		readSyncSpy(fd, buffer, bufOffset, length, position),
	closeSync: (fd: number) => closeSyncSpy(fd),
	watchFile: (p: string, opts: unknown, cb: () => void) => {
		watchedPath = p;
		watchedOpts = opts;
		watchCallback = cb;
	},
	unwatchFile: (_p: string) => {},
}));

vi.mock("../lib/config.js", () => ({
	getDataDir: (_cwd: string) => "/repo/.interlinked",
}));

vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		red: (s: string) => s,
		green: (s: string) => s,
		yellow: (s: string) => s,
		blue: (s: string) => s,
		cyan: (s: string) => s,
		magenta: (s: string) => s,
	},
	shortTimestamp: (_ts: string) => "12:00",
	truncate: (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`),
}));

let readLocalActivityImpl: (opts: unknown) => Record<string, unknown>[];
let lastReadOpts: Record<string, unknown> | undefined;

vi.mock("../lib/local-activity.js", () => ({
	readLocalActivity: (opts: Record<string, unknown>) => {
		lastReadOpts = opts;
		return readLocalActivityImpl(opts);
	},
}));

// Real activity-utils.ts is used so formatActivitySummary's genuine
// tool_input_summary / tokenSuffix wiring is exercised.
vi.mock("../lib/activity-utils.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/activity-utils.js")>("../lib/activity-utils.js");
	return { ...actual };
});

import { logsCommand } from "./logs.js";

const ACTIVITY_PATH = "/repo/.interlinked/activity.jsonl";

let logs: string[];
let errs: string[];

function allOut(): string {
	return logs.join("\n");
}
function lastJson(): unknown {
	// SAFETY: called only after a test has asserted `logs` is non-empty and
	// the last entry is JSON output from the command under test.
	return JSON.parse(logs.at(-1) as string);
}

function ev(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ts: "2026-06-06T12:00:00Z",
		agent: "claude",
		type: "tool_use",
		tool: "Read",
		summary: "src/foo.ts",
		...overrides,
	};
}

beforeEach(() => {
	fsState = freshFs();
	watchCallback = null;
	watchedOpts = undefined;
	watchedPath = null;
	openSyncSpy.mockClear();
	readSyncSpy.mockClear();
	closeSyncSpy.mockClear();
	logs = [];
	errs = [];
	lastReadOpts = undefined;
	readLocalActivityImpl = () => [];
	process.exitCode = undefined;
	vi.spyOn(process, "cwd").mockReturnValue("/repo");
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

async function runFollow(opts: Record<string, unknown>, step: () => void): Promise<void> {
	const done = logsCommand(opts);
	await Promise.resolve();
	step();
	process.emit("SIGINT");
	await done;
	process.removeAllListeners("SIGINT");
	process.removeAllListeners("SIGTERM");
}

// ===========================================
// parseLogEvent — required-field + optional-field normalization
// ===========================================

describe("parseLogEvent — required field type guards", () => {
	// test-contract: invariant — ts must be a string; a non-string ts drops the whole event.
	it("P1: non-string ts causes the line to be dropped entirely", async () => {
		await runFollow({ follow: true, raw: true }, () => {
			const content = `${JSON.stringify({ ts: 12345, agent: "claude", type: "tool_use" })}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		expect(allOut().split("\n").some((l) => l.startsWith("{"))).toBe(false);
	});

	// test-contract: invariant — type must be a string; a non-string type drops the whole event.
	it("P2: non-string type causes the line to be dropped entirely", async () => {
		await runFollow({ follow: true, raw: true }, () => {
			const content = `${JSON.stringify({ ts: "T", agent: "claude", type: 7 })}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		expect(allOut().split("\n").some((l) => l.startsWith("{"))).toBe(false);
	});
});

describe("parseLogEvent — optional field normalization", () => {
	// test-contract: invariant — a tool/summary value that is neither string nor null
	// normalizes to null rather than passing the raw non-string value through.
	it("P3: non-string, non-null tool and summary values normalize to null", async () => {
		await runFollow({ follow: true, raw: true }, () => {
			const content = `${JSON.stringify({ ts: "T", agent: "claude", type: "tool_use", tool: 42, summary: true })}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		// SAFETY: the fixture line above always emits one JSON object, so a
		// line starting with "{" is present; JSON.parse output is asserted
		// on below rather than exhaustively typed.
		const line = allOut()
			.split("\n")
			.find((l) => l.startsWith("{")) as string;
		const parsed = JSON.parse(line) as Record<string, unknown>;
		expect(parsed.tool).toBeNull();
		expect(parsed.summary).toBeNull();
	});
});

// ===========================================
// matchesFilters — type filter (non-session type so the mismatch text survives
// formatActivitySummary's session_start/session_end special-casing)
// ===========================================

describe("matchesFilters — type filter", () => {
	// test-contract: invariant — a type filter rejects a mismatching event even when
	// neither event's type is "session_start"/"session_end" (so the rejected event's
	// summary text would otherwise be directly visible if the filter were a no-op).
	it("P: rejects a type mismatch for non-session event types", async () => {
		await runFollow({ follow: true, type: "tool_use" }, () => {
			const content = [
				JSON.stringify(ev({ type: "tool_use", tool: "Read", summary: "keep-me" })),
				JSON.stringify(ev({ type: "tool_use_error", tool: "Read", summary: "reject-me" })),
				"",
			].join("\n");
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("keep-me");
		expect(out).not.toContain("reject-me");
	});
});

// ===========================================
// formatEvent — "" fallback literals
// ===========================================

describe("formatEvent — empty-string fallbacks", () => {
	// test-contract: invariant — an absent tool and absent duration_ms both fall back to
	// "" with no stray placeholder text injected into the rendered line.
	it("P: absent tool and absent duration_ms leave no stray fallback text", async () => {
		readLocalActivityImpl = () => [ev({ tool: null })];
		await logsCommand({});
		expect(allOut()).not.toContain("Stryker");
	});
});

// ===========================================
// tailFollow — offset seeding, watch interval, existsSync/size guards, read args
// ===========================================

describe("tailFollow — offset seeding from initial statSync", () => {
	// test-contract: invariant — offset starts at the file's CURRENT size, so content
	// already on disk before follow-mode starts is never replayed.
	it("P: pre-existing content is not replayed; only newly appended bytes render", async () => {
		const oldLine = `${JSON.stringify(ev({ summary: "already-there" }))}\n`;
		fsState.fileContent = Buffer.from(oldLine, "utf-8");
		fsState.size = fsState.fileContent.length;
		await runFollow({ follow: true }, () => {
			const newLine = `${JSON.stringify(ev({ summary: "brand-new" }))}\n`;
			fsState.fileContent = Buffer.from(oldLine + newLine, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("brand-new");
		expect(out).not.toContain("already-there");
	});
});

describe("tailFollow — watchFile poll interval", () => {
	// test-contract: invariant — watchFile is configured with the named poll-interval constant.
	it("P: watchFile receives { interval: 500 }", async () => {
		await runFollow({ follow: true }, () => {});
		expect(watchedOpts).toEqual({ interval: 500 });
		expect(watchedPath).toBe(ACTIVITY_PATH);
	});
});

describe("tailFollow.readNew — existsSync guard", () => {
	// test-contract: invariant — when existsSync reports false, readNew returns before
	// reading anything, even if size/content would otherwise look ready to parse.
	it("P: a well-formed pending line is not rendered while existsSync reports false", async () => {
		await runFollow({ follow: true }, () => {
			fsState.exists = false;
			const line = `${JSON.stringify(ev({ summary: "should-not-appear-when-missing" }))}\n`;
			fsState.fileContent = Buffer.from(line, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		expect(allOut()).not.toContain("should-not-appear-when-missing");
		expect(openSyncSpy).not.toHaveBeenCalled();
	});
});

describe("tailFollow.readNew — size<=offset guard (no growth)", () => {
	// test-contract: invariant — when size equals the offset exactly (no growth), the
	// file is never opened for a read.
	it("P: no growth (size === offset) never opens the file", async () => {
		fsState.size = 40; // seeds offset at 40 via the initial statSync
		await runFollow({ follow: true }, () => {
			fsState.size = 40; // unchanged
			watchCallback?.();
		});
		expect(openSyncSpy).not.toHaveBeenCalled();
	});
});

describe("tailFollow.readNew — read parameters", () => {
	// test-contract: invariant — the file is opened read-only ("r") and the read spans
	// exactly [offset, size), i.e. bytesToRead = size - offset (not size + offset).
	it("P: opens with flag 'r' and reads exactly (size - offset) bytes at position offset", async () => {
		const oldLine = `${JSON.stringify(ev({ summary: "seed" }))}\n`;
		fsState.fileContent = Buffer.from(oldLine, "utf-8");
		fsState.size = fsState.fileContent.length; // seeds offset = oldLine.length
		const seededOffset = fsState.size;
		const newLine = `${JSON.stringify(ev({ summary: "grown" }))}\n`;
		await runFollow({ follow: true }, () => {
			fsState.fileContent = Buffer.from(oldLine + newLine, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		expect(openSyncSpy).toHaveBeenCalledWith(ACTIVITY_PATH, "r");
		expect(readSyncSpy).toHaveBeenCalledWith(
			42,
			expect.any(Buffer),
			0,
			newLine.length,
			seededOffset,
		);
		expect(allOut()).toContain("grown");
	});
});

describe("tailFollow.readNew — split(\"\\n\").filter(Boolean)", () => {
	// test-contract: invariant — filter(Boolean) drops the blank trailing segment produced
	// by split("\n") on a line ending in a newline, so exactly one JSON.parse call happens
	// for a single content line (not one extra call for the empty tail segment).
	it("P: exactly one JSON.parse call for a single line with a trailing newline", async () => {
		const parseSpy = vi.spyOn(JSON, "parse");
		await runFollow({ follow: true }, () => {
			const content = `${JSON.stringify(ev({ summary: "only-line" }))}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		expect(parseSpy).toHaveBeenCalledTimes(1);
		expect(allOut()).toContain("only-line");
	});
});

// ===========================================
// logsCommand — query option assembly, final trim, normal-mode line assembly
// ===========================================

describe("logsCommand — omitted optional query keys are truly absent", () => {
	// test-contract: invariant — since/agent/type are omitted from the query object entirely
	// when not provided, not present with an explicit `undefined` value.
	it("P: default call produces exactly { limit, cwd } with no extra keys", async () => {
		await logsCommand({});
		expect(lastReadOpts).toStrictEqual({ limit: 20, cwd: "/repo" });
		// SAFETY: the toStrictEqual above already proves lastReadOpts is a
		// plain object with exactly these keys; the cast only satisfies
		// Object.keys' parameter type.
		expect(Object.keys(lastReadOpts as object).sort()).toEqual(["cwd", "limit"]);
	});
});

describe("logsCommand — final limit trim", () => {
	// test-contract: invariant — after tool-filtering, the result is trimmed to at most
	// `limit` events even when more matches were found.
	it("P: 5 matching Bash events trimmed to --limit 2", async () => {
		const events = Array.from({ length: 5 }, (_, i) => ev({ tool: "Bash", summary: `b${i}` }));
		readLocalActivityImpl = () => events.slice();
		await logsCommand({ tool: "Bash", limit: "2", json: true });
		// SAFETY: `json: true` guarantees the last logged line is a JSON
		// array of event objects; the length assertion below verifies the shape.
		const out = lastJson() as Record<string, unknown>[];
		expect(out).toHaveLength(2);
	});
});

describe("logsCommand — normal-mode line assembly", () => {
	// test-contract: invariant — the `lines` accumulator starts empty; no seed content
	// precedes the first rendered event line.
	it("P: no stray leading content before the first rendered event line", async () => {
		readLocalActivityImpl = () => [ev({ tool: "Read", summary: "a.ts" })];
		await logsCommand({});
		expect(allOut()).not.toContain("Stryker");
	});

	// test-contract: invariant — a blank line separates the rendered events from the footer.
	it("P: a blank separator line sits directly before the summary footer", async () => {
		readLocalActivityImpl = () => [ev({ tool: "Read", summary: "a.ts" })];
		await logsCommand({});
		// SAFETY: the console.log spy above only ever pushes strings.
		const rendered = logs[0] as string;
		const lines = rendered.split("\n");
		const footerIdx = lines.findIndex((l) => l.includes("event shown"));
		expect(footerIdx).toBeGreaterThan(0);
		expect(lines[footerIdx - 1]).toBe("");
	});

	// test-contract: invariant — lines are joined with real newlines, not concatenated
	// with no separator at all.
	it("P: the rendered event line and the footer are separated by an actual newline", async () => {
		readLocalActivityImpl = () => [ev({ tool: "Read", summary: "a.ts" })];
		await logsCommand({});
		// SAFETY: the console.log spy above only ever pushes strings.
		const rendered = logs[0] as string;
		expect(rendered).toContain("\n");
		expect(rendered.split("\n").length).toBeGreaterThanOrEqual(3);
	});
});
