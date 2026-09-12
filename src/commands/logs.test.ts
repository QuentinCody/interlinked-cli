import { parseWire, wireArray, wireNumber, wireObject, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
// ===========================================
// interlinked logs — behavioral coverage
// ===========================================
// Deep behavioral tests for logsCommand. Mocks the module boundaries
// (node:fs, ../lib/config, ../lib/local-activity, ../lib/formatter) so
// every branch is driven deterministically — no real filesystem, network,
// or wall-clock time. The REAL output.ts and activity-utils.ts are used so
// the actual mode-dispatch + summary formatting is exercised.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- node:fs mock -------------------------------------------------------
// A virtual filesystem + tail-driver. `existsSync`/`statSync` are backed by
// mutable state so the follow-mode poll can be stepped. `watchFile` captures
// its callback so the test can fire it on demand; `readSync` serves bytes
// from `fileContent`.
interface FsState {
	exists: boolean;
	size: number;
	statThrows: boolean;
	fileContent: Buffer;
}

let fsState: FsState;
let watchCallback: (() => void) | null;
let watchedPath: string | null;
let unwatchedPath: string | null;
const openFds: number[] = [];

function freshFs(): FsState {
	return { exists: true, size: 0, statThrows: false, fileContent: Buffer.alloc(0) };
}

vi.mock("node:fs", () => ({
	existsSync: (_p: string) => fsState.exists,
	statSync: (_p: string) => {
		if (fsState.statThrows) throw new Error("ENOENT stat");
		return { size: fsState.size };
	},
	openSync: (_p: string) => {
		const fd = 42;
		openFds.push(fd);
		return fd;
	},
	readSync: (_fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
		const slice = fsState.fileContent.subarray(position, position + length);
		slice.copy(buffer, offset);
		return slice.length;
	},
	closeSync: (fd: number) => {
		const i = openFds.indexOf(fd);
		if (i >= 0) openFds.splice(i, 1);
	},
	watchFile: (p: string, _opts: unknown, cb: () => void) => {
		watchedPath = p;
		watchCallback = cb;
	},
	unwatchFile: (p: string) => {
		unwatchedPath = p;
	},
}));

// ---- config mock: deterministic data dir --------------------------------
vi.mock("../lib/config.js", () => ({
	getDataDir: (_cwd: string) => "/repo/.interlinked",
}));

// ---- formatter mock: identity colors + deterministic timestamp ----------
// Plain (uncolored) strings make output assertions exact; shortTimestamp is
// pinned so it doesn't depend on the machine's locale/timezone.
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
	// truncate is used transitively by the REAL activity-utils.formatActivitySummary.
	truncate: (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`),
}));

// ---- local-activity mock: scripted event source ------------------------
let readLocalActivityImpl: (opts: unknown) => Record<string, unknown>[];
let lastReadOpts: Record<string, unknown> | undefined;

vi.mock("../lib/local-activity.js", () => ({
	readLocalActivity: (opts: Record<string, unknown>) => {
		lastReadOpts = opts;
		return readLocalActivityImpl(opts);
	},
}));

// ---- activity-utils mock: real formatActivitySummary, overridable parseDuration
// formatActivitySummary stays the real implementation so formatEvent exercises
// genuine summary wiring; parseDuration delegates to the real parser by default
// but a single test swaps in a non-Error thrower to cover the String(e) arm.
let parseDurationImpl: ((s: string) => number) | null = null;
vi.mock("../lib/activity-utils.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/activity-utils.js")>("../lib/activity-utils.js");
	return {
		...actual,
		parseDuration: (s: string) => (parseDurationImpl ?? actual.parseDuration)(s),
	};
});

// Real output.ts + activity-utils.ts are used (no stub) so the actual
// dispatch + summary wiring runs.
import { logsCommand } from "./logs.js";

const ACTIVITY_PATH = "/repo/.interlinked/activity.jsonl";

let logs: string[];
let errs: string[];

function allOut(): string {
	return logs.join("\n");
}
function allErr(): string {
	return errs.join("\n");
}
function lastJson(): unknown {
	return JSON.parse(nonNull(logs.at(-1)));
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
	watchedPath = null;
	unwatchedPath = null;
	openFds.length = 0;
	logs = [];
	errs = [];
	lastReadOpts = undefined;
	readLocalActivityImpl = () => [];
	parseDurationImpl = null;
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

// ===========================================
// Guard / error paths (static mode)
// ===========================================

describe("logsCommand — guard paths", () => {
	it("no activity log: errors and sets exit code, does not read events", async () => {
		fsState.exists = false;
		await logsCommand({});
		expect(allErr()).toContain(
			"Error: No activity log found. Run `interlinked enable` to install hooks.",
		);
		expect(process.exitCode).toBe(1);
		expect(lastReadOpts).toBeUndefined();
	});

	it("no activity log in json mode: structured error", async () => {
		fsState.exists = false;
		await logsCommand({ json: true });
		const payload = parseWire(JSON.parse(nonNull(errs.at(-1))), wireObject({ "error": wireString }), "test JSON value");
		expect(payload.error).toBe(
			"No activity log found. Run `interlinked enable` to install hooks.",
		);
		expect(process.exitCode).toBe(1);
	});

	it("invalid --limit (non-numeric): errors with the offending value", async () => {
		await logsCommand({ limit: "abc" });
		expect(allErr()).toContain('Invalid --limit: "abc". Expected a positive integer.');
		expect(process.exitCode).toBe(1);
		expect(lastReadOpts).toBeUndefined();
	});

	it("invalid --limit (zero): rejected as non-positive", async () => {
		await logsCommand({ limit: "0" });
		expect(allErr()).toContain('Invalid --limit: "0". Expected a positive integer.');
		expect(process.exitCode).toBe(1);
	});

	it("invalid --limit (negative): rejected as non-positive", async () => {
		await logsCommand({ limit: "-5" });
		expect(allErr()).toContain('Invalid --limit: "-5". Expected a positive integer.');
		expect(process.exitCode).toBe(1);
	});

	it("invalid --since: surfaces parseDuration message", async () => {
		await logsCommand({ since: "soon" });
		expect(allErr()).toContain('Invalid duration "soon"');
		expect(process.exitCode).toBe(1);
		expect(lastReadOpts).toBeUndefined();
	});

	it("non-Error thrown by parseDuration is stringified (String(e) arm)", async () => {
		// Defensive arm: parseDuration only ever throws Error in practice, so a
		// non-Error throw is forced here to cover the `String(e)` fallback.
		parseDurationImpl = () => {
			throw "boom-string"; // eslint-disable-line no-throw-literal
		};
		await logsCommand({ since: "1h" });
		expect(allErr()).toContain("Error: boom-string");
		expect(process.exitCode).toBe(1);
		expect(lastReadOpts).toBeUndefined();
	});
});

// ===========================================
// readLocalActivity option assembly
// ===========================================

describe("logsCommand — query option assembly", () => {
	it("defaults: limit 20, no since/agent/type spread", async () => {
		await logsCommand({});
		expect(lastReadOpts).toEqual({ limit: 20, cwd: "/repo" });
	});

	it("valid --since sets a numeric cutoff in the past", async () => {
		const before = Date.now();
		await logsCommand({ since: "1h" });
		const opts = parseWire(lastReadOpts, wireObject({ "since": wireNumber, "limit": wireNumber, "cwd": wireString }), "test JSON value");
		expect(opts.limit).toBe(20);
		// 1h ago, computed as Date.now() - 3_600_000.
		expect(opts.since).toBeLessThanOrEqual(before - 3_600_000 + 5);
		expect(opts.since).toBeGreaterThanOrEqual(before - 3_600_000 - 5_000);
	});

	it("agent + type are forwarded into the query", async () => {
		await logsCommand({ agent: "gemini", type: "session_start" });
		expect(lastReadOpts).toEqual({
			agent: "gemini",
			type: "session_start",
			limit: 20,
			cwd: "/repo",
		});
	});

	it("tool filter over-fetches (limit * 5) then trims to limit", async () => {
		// 8 Read events, 2 Bash; --tool Bash --limit 3 should keep both Bash.
		const events = [
			...Array.from({ length: 8 }, (_, i) => ev({ tool: "Read", summary: `r${i}` })),
			ev({ tool: "Bash", summary: "ls" }),
			ev({ tool: "Bash", summary: "pwd" }),
		];
		readLocalActivityImpl = () => events.slice();
		await logsCommand({ tool: "Bash", limit: "3", json: true });
		// Over-fetch budget = 3 * 5 = 15.
		expect(lastReadOpts).toHaveProperty(["limit"], 15);
		const out = parseWire(lastJson(), wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(out).toHaveLength(2);
		expect(out.every((e) => e.tool === "Bash")).toBe(true);
	});

	it("custom --limit (no tool) is passed through unmultiplied", async () => {
		await logsCommand({ limit: "7" });
		expect(lastReadOpts).toHaveProperty(["limit"], 7);
	});
});

// ===========================================
// Output: json mode
// ===========================================

describe("logsCommand — json mode", () => {
	it("returns the (chronologically reversed) event array", async () => {
		// readLocalActivity yields newest-first; logs reverses to oldest-first.
		readLocalActivityImpl = () => [ev({ summary: "newest" }), ev({ summary: "oldest" })];
		await logsCommand({ json: true });
		const out = parseWire(lastJson(), wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(out.map((e) => e.summary)).toEqual(["oldest", "newest"]);
	});

	it("empty result is an empty array", async () => {
		await logsCommand({ json: true });
		expect(lastJson()).toEqual([]);
	});
});

// ===========================================
// Output: short mode
// ===========================================

describe("logsCommand — short mode", () => {
	it("empty: prints 'No activity.'", async () => {
		await logsCommand({ short: true });
		expect(allOut()).toBe("No activity.");
	});

	it("populated: one line per event (ts agent type tool)", async () => {
		readLocalActivityImpl = () => [
			ev({ ts: "T1", agent: "claude", type: "tool_use", tool: "Read" }),
			ev({ ts: "T2", agent: "gemini", type: "session_start", tool: null }),
		];
		await logsCommand({ short: true });
		const out = allOut();
		// reversed → T2 first. Null tool collapses to "" via `e.tool || ""`.
		expect(out).toBe("T2 gemini session_start \nT1 claude tool_use Read");
	});
});

// ===========================================
// Output: normal mode (and full -> normal fallback)
// ===========================================

describe("logsCommand — normal mode", () => {
	it("empty: prints the dim 'No recent activity' hint", async () => {
		await logsCommand({});
		expect(allOut()).toContain("No recent activity. Hooks may not be installed yet.");
	});

	it("populated: formatted lines + singular footer for one event", async () => {
		readLocalActivityImpl = () => [ev({ tool: "Read", summary: "src/a.ts" })];
		await logsCommand({});
		const out = allOut();
		expect(out).toContain("12:00 claude TOOL Read Read src/a.ts");
		expect(out).toContain("1 event shown. Use -f to follow in real-time.");
		expect(out).not.toContain("1 events shown");
	});

	it("populated: plural footer for multiple events", async () => {
		readLocalActivityImpl = () => [ev(), ev(), ev()];
		await logsCommand({});
		expect(allOut()).toContain("3 events shown. Use -f to follow in real-time.");
	});

	it("--raw renders each event as JSON instead of formatted line", async () => {
		readLocalActivityImpl = () => [ev({ summary: "raw-me" })];
		await logsCommand({ raw: true });
		const out = allOut();
		expect(out).toContain('"summary":"raw-me"');
		// footer is still appended in normal mode
		expect(out).toContain("1 event shown.");
	});

	it("full mode falls back to the normal renderer", async () => {
		readLocalActivityImpl = () => [ev({ tool: "Read", summary: "src/a.ts" })];
		await logsCommand({ full: true });
		expect(allOut()).toContain("12:00 claude TOOL Read Read src/a.ts");
	});

	it("duration_ms is appended when present", async () => {
		readLocalActivityImpl = () => [ev({ tool: "Bash", summary: "ls", duration_ms: 250 })];
		await logsCommand({});
		expect(allOut()).toContain("250ms");
	});

	it("missing agent renders '?', token suffix appears when tokens present", async () => {
		readLocalActivityImpl = () => [
			ev({ agent: "", tool: "Read", summary: "x.ts", tokens: { input: 1200, output: 800 } }),
		];
		await logsCommand({});
		const out = allOut();
		expect(out).toContain("12:00 ?");
		expect(out).toContain("2.0k tok");
	});

	it.each([{ input: "unknown", output: 1200 }, { input: 1200, output: null }])("renders the known token count when the other counter is malformed: %j", async (tokens) => {
		readLocalActivityImpl = () => [ev({ tool: "Read", summary: "x.ts", tokens })];
		await logsCommand({});
		expect(allOut()).toContain("1.2k tok");
		expect(allOut()).not.toContain("NaN");
	});

	it("event without a tool omits the tool segment", async () => {
		readLocalActivityImpl = () => [ev({ type: "user_prompt", tool: null, summary: "hello" })];
		await logsCommand({});
		// No double-space where the tool would be; label sits right before summary.
		expect(allOut()).toContain("12:00 claude PROMPT ");
	});

	it("event with an absent summary coerces to null (no crash, 'Used <tool>')", async () => {
		// `summary` undefined exercises the null arm of `event.summary ?? null`.
		const e = ev({ tool: "CustomTool" });
		delete e.summary;
		readLocalActivityImpl = () => [e];
		await logsCommand({});
		// formatActivitySummary falls back to "Used <tool>" when input is empty.
		expect(allOut()).toContain("Used CustomTool");
	});
});

// ===========================================
// eventTypeColor — every switch arm (via formatEvent label)
// ===========================================

describe("logsCommand — event type labels", () => {
	const cases: Array<[string, string]> = [
		["session_start", "START"],
		["session_end", "END"],
		["agent_stop", "END"],
		["tool_use", "TOOL"],
		["tool_use_start", "TOOL>"],
		["tool_use_error", "ERROR"],
		["user_prompt", "PROMPT"],
		["subagent_start", "SUB>"],
		["subagent_stop", "SUB<"],
		["context_compact", "COMPACT"],
		["task_completed", "TASK-DONE"],
		["teammate_idle", "IDLE"],
		["notification", "NOTIFY"],
		["permission_request", "PERM"],
		["something_unknown", "something_unknown"], // default arm echoes the type
	];

	for (const [type, label] of cases) {
		it(`type '${type}' renders label '${label}'`, async () => {
			readLocalActivityImpl = () => [ev({ type, tool: null, summary: "" })];
			await logsCommand({});
			// label sits between the agent and the summary on the event line.
			expect(allOut()).toContain(`claude ${label}`);
		});
	}
});

// ===========================================
// Follow mode (tailFollow)
// ===========================================

describe("logsCommand — follow mode", () => {
	// Drive the tail: install the watcher, then step it via the captured
	// callback, then resolve by emitting SIGINT. The logsCommand promise only
	// settles after cleanup runs, so we step then signal then await.
	async function runFollow(opts: Record<string, unknown>, step: () => void): Promise<void> {
		const done = logsCommand(opts);
		// Microtask so tailFollow has installed watchFile + signal handlers.
		await Promise.resolve();
		step();
		process.emit("SIGINT");
		await done;
		process.removeAllListeners("SIGINT");
		process.removeAllListeners("SIGTERM");
	}

	it("initial offset comes from file size; new bytes are parsed + printed", async () => {
		fsState.size = 0; // start-of-tail offset
		await runFollow({ follow: true }, () => {
			// Append two JSONL lines (one valid, one blank that filters out).
			const line = `${JSON.stringify(ev({ summary: "tailed" }))}\n\n`;
			fsState.fileContent = Buffer.from(line, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("Following /repo/.interlinked/activity.jsonl");
		expect(out).toContain("12:00 claude TOOL Read Read tailed");
		expect(out).toContain("--- Stopped ---");
		expect(watchedPath).toBe(ACTIVITY_PATH);
		expect(unwatchedPath).toBe(ACTIVITY_PATH);
		// fds are balanced (every openSync got a closeSync).
		expect(openFds).toEqual([]);
	});

	it("initial statSync failure starts tail at offset 0", async () => {
		fsState.statThrows = true; // first statSync (offset seed) throws
		await runFollow({ follow: true }, () => {
			fsState.statThrows = false;
			const line = `${JSON.stringify(ev({ summary: "after-throw" }))}\n`;
			fsState.fileContent = Buffer.from(line, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		expect(allOut()).toContain("after-throw");
	});

	it("readNew is a no-op when the file is gone", async () => {
		await runFollow({ follow: true }, () => {
			fsState.exists = false; // existsSync -> false in readNew
			fsState.size = 999;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("Following");
		expect(out).not.toContain("TOOL");
	});

	it("readNew is a no-op when size has not grown past the offset", async () => {
		fsState.size = 100; // offset seeded at 100
		await runFollow({ follow: true }, () => {
			fsState.size = 100; // unchanged -> size <= offset
			watchCallback?.();
		});
		expect(allOut()).not.toContain("TOOL");
	});

	it("malformed JSONL lines are skipped without throwing", async () => {
		await runFollow({ follow: true }, () => {
			const content = `not-json\n${JSON.stringify(ev({ summary: "good" }))}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("good");
		expect(out).not.toContain("not-json");
	});

	// -- parseLogEvent (via tailFollow's readNew) — well-formed vs malformed --

	it("P1: a well-formed event (ts/agent/type all strings) is parsed and rendered", async () => {
		await runFollow({ follow: true }, () => {
			const content = `${JSON.stringify(ev({ summary: "wellformed" }))}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		expect(allOut()).toContain("wellformed");
	});

	it("P2: extra unrecognized keys (e.g. tokens) survive through to formatEvent", async () => {
		// LogEvent carries an index signature specifically so callers can read
		// arbitrary extra keys (formatEvent reads `event.tokens`) -- the parser
		// must not silently drop them from the constructed literal.
		await runFollow({ follow: true }, () => {
			const content = `${JSON.stringify(ev({ summary: "x.ts", tokens: { input: 1200, output: 800 } }))}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		expect(allOut()).toContain("2.0k tok");
	});

	it("N1: a line that parses to a top-level JSON array is skipped, not rendered", async () => {
		await runFollow({ follow: true }, () => {
			const content = `${JSON.stringify(["not", "an", "event"])}\n${JSON.stringify(ev({ summary: "good" }))}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("good");
		expect(out).not.toContain("not,an,event");
	});

	it("N2: a line missing a required field (agent) is skipped rather than rendered with a garbage fallback", async () => {
		await runFollow({ follow: true }, () => {
			const missingAgent = ev({ summary: "should-not-print" });
			delete missingAgent.agent;
			const content = `${JSON.stringify(missingAgent)}\n${JSON.stringify(ev({ summary: "good" }))}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("good");
		expect(out).not.toContain("should-not-print");
	});

	it("N3: a bare JSON null line is skipped without throwing", async () => {
		await runFollow({ follow: true }, () => {
			const content = `null\n${JSON.stringify(ev({ summary: "good" }))}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("good");
		expect(out).toContain("Following"); // no crash -- banner + event both rendered
	});

	it("a read error inside readNew is swallowed (best-effort tail)", async () => {
		await runFollow({ follow: true }, () => {
			fsState.size = 50; // grows past offset 0 so the read path is entered
			fsState.statThrows = true; // statSync inside readNew now throws
			watchCallback?.();
		});
		// No crash; just the banner + stop line.
		expect(allOut()).toContain("Following");
		expect(allOut()).toContain("--- Stopped ---");
	});

	it("filters apply to followed events (agent mismatch is dropped)", async () => {
		await runFollow({ follow: true, agent: "gemini" }, () => {
			const content = `${JSON.stringify(ev({ agent: "claude", summary: "drop" }))}\n${JSON.stringify(
				ev({ agent: "gemini", summary: "keep" }),
			)}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("keep");
		expect(out).not.toContain("drop");
	});

	it("tool + type filters apply to followed events", async () => {
		await runFollow({ follow: true, tool: "Bash", type: "tool_use" }, () => {
			const content = [
				JSON.stringify(ev({ tool: "Read", type: "tool_use", summary: "wrong-tool" })),
				JSON.stringify(ev({ tool: "Bash", type: "session_start", summary: "wrong-type" })),
				JSON.stringify(ev({ tool: "Bash", type: "tool_use", summary: "right" })),
				"",
			].join("\n");
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		const out = allOut();
		expect(out).toContain("right");
		expect(out).not.toContain("wrong-tool");
		expect(out).not.toContain("wrong-type");
	});

	it("--raw in follow mode emits JSON lines for matched events", async () => {
		await runFollow({ follow: true, raw: true }, () => {
			const content = `${JSON.stringify(ev({ summary: "raw-tail" }))}\n`;
			fsState.fileContent = Buffer.from(content, "utf-8");
			fsState.size = fsState.fileContent.length;
			watchCallback?.();
		});
		expect(allOut()).toContain('"summary":"raw-tail"');
	});

	it("follow mode resolves cleanly via SIGTERM as well", async () => {
		const done = logsCommand({ follow: true });
		await Promise.resolve();
		process.emit("SIGTERM");
		await done;
		process.removeAllListeners("SIGINT");
		process.removeAllListeners("SIGTERM");
		expect(allOut()).toContain("--- Stopped ---");
		expect(unwatchedPath).toBe(ACTIVITY_PATH);
	});
});
