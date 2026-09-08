import { wireLiteral } from "../lib/value-validation.js";
import { parseWire, wireArray, wireBoolean, wireObject, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked telemetry — behavioral coverage
// ===========================================
// Deep behavioral tests for telemetryShowCommand. Mocks the module
// boundaries (node:fs, node:fs/promises, node:readline, and the
// ../harness/telemetry-spool source) so every branch is driven
// deterministically — no real filesystem, no wall-clock watchFile, no
// process.exit. We assert real output strings, side-effects, and that the
// right spool path / readline source were used.
//
// Branch map driven below (every arm of telemetry.ts):
//   telemetryShowCommand
//     · spool missing  -> json arm    (ok:true, events:[], path)
//     · spool missing  -> non-json arm ("no spool at <path>")
//     · custom options.spool path is honored (?? default)
//     · follow:true    -> delegates to followSpool (early return; the
//       `waitForever` test hook on TelemetryOptions lets that await
//       actually resolve so the return path itself gets exercised)
//     · static + json  -> pretty-printed {events, path}
//     · static + text  -> printEventLine per event
//     · limit null     -> events (no slice)
//     · limit set      -> events.slice(-limit)
//   followSpool
//     · printInitial true (limit defined) -> prints existing slice
//     · printInitial false (limit undefined) -> no initial print
//     · limit null vs set inside the initial print
//     · installs watchFile; grows -> reads tail via readline
//     · grows-but-not-past-lastSize guard (curr.size <= lastSize -> skip)
//   handleLine
//     · empty line -> ignored
//     · JSON.parse throw (malformed) -> ignored
//     · parsed null / non-object -> ignored
//     · json arm -> writes the raw line back
//     · text arm -> printEventLine
//   printEventLine
//     · kind === hook_decision with decision string -> extra column
//     · kind === hook_decision with decision absent  -> "" (?? arm)
//     · kind !== hook_decision -> "" extra
//     · session_id non-string -> "-" placeholder
//   parseLimit
//     · undefined -> null
//     · valid positive int -> n
//     · zero / negative / NaN -> null

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpoolEvent } from "../harness/telemetry-spool.js";

// ---- node:fs mock -------------------------------------------------------
// existsSync is mutable per-test. createReadStream returns a sentinel whose
// close() is recorded. watchFile captures its callback + opts so the test can
// fire the grow event on demand and assert the poll interval.
let existsImpl: (p: string) => boolean;
const createdStreams: Array<{ path: string; start: number; closed: boolean }> = [];
let watchCb: ((curr: { size: number }) => void) | null;
let watchOpts: { interval: number } | undefined;
let watchedPath: string | null;

vi.mock("node:fs", () => ({
	existsSync: (p: string) => existsImpl(p),
	createReadStream: (path: string, opts: { start: number }) => {
		const handle = { path, start: opts.start, closed: false };
		createdStreams.push(handle);
		return {
			__handle: handle,
			close: () => {
				handle.closed = true;
			},
		};
	},
	watchFile: (p: string, opts: { interval: number }, cb: (curr: { size: number }) => void) => {
		watchedPath = p;
		watchOpts = opts;
		watchCb = cb;
	},
}));

// ---- node:fs/promises mock ----------------------------------------------
// Only stat() is used (the initial size seed inside followSpool). Mutable so a
// test can pin the seed offset that the first tail read starts from.
let statSize: number;
vi.mock("node:fs/promises", () => ({
	stat: async (_p: string) => ({ size: statSize }),
}));

// ---- node:readline mock -------------------------------------------------
// createInterface returns an emitter-ish object recording handlers. The test
// pumps lines via the captured handlers, then fires "close". Each interface
// instance is tracked so we can drive whichever one followSpool just made.
interface FakeRl {
	lineHandlers: Array<(line: string) => void>;
	closeHandlers: Array<() => void>;
	input: { __handle: { path: string; start: number; closed: boolean } };
	emitLine: (line: string) => void;
	emitClose: () => void;
}
const createdInterfaces: FakeRl[] = [];
vi.mock("node:readline", () => ({
	createInterface: (opts: { input: { __handle: FakeRl["input"]["__handle"] } }) => {
		const rl: FakeRl = {
			lineHandlers: [],
			closeHandlers: [],
			input: opts.input,
			emitLine: (line: string) => {
				for (const h of rl.lineHandlers) h(line);
			},
			emitClose: () => {
				for (const h of rl.closeHandlers) h();
			},
		};
		const api = {
			on: (event: string, handler: (...args: unknown[]) => void) => {
				if (event === "line") rl.lineHandlers.push(handler);
				if (event === "close") rl.closeHandlers.push(handler);
				return api;
			},
		};
		createdInterfaces.push(rl);
		return api;
	},
}));

// ---- telemetry-spool mock ----------------------------------------------
// createTelemetrySpool().readAll() returns a scripted event list. lastSpoolOpts
// captures the path the command resolved so we can assert default-vs-custom.
let readAllImpl: () => SpoolEvent[];
let lastSpoolOpts: { spoolPath: string } | undefined;
vi.mock("../harness/telemetry-spool.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../harness/telemetry-spool.js")>(),
	createTelemetrySpool: (opts: { spoolPath: string }) => {
		lastSpoolOpts = opts;
		return { readAll: () => readAllImpl() };
	},
}));

import { nonNull } from "../lib/non-null.js";
// Real telemetry.ts under test (its node:* + spool deps are all mocked above).
import { telemetryShowCommand } from "./telemetry.js";

// ---- stdout capture -----------------------------------------------------
let out: string;
function captured(): string {
	return out;
}

function ev(overrides: Partial<SpoolEvent> = {}): SpoolEvent {
	return {
		schema: "v1",
		kind: "hook_decision",
		ts: "2026-04-23T00:00:00.000Z",
		session_id: "s1",
		...overrides,
	};
}

beforeEach(() => {
	out = "";
	existsImpl = () => true;
	createdStreams.length = 0;
	createdInterfaces.length = 0;
	watchCb = null;
	watchOpts = undefined;
	watchedPath = null;
	statSize = 0;
	readAllImpl = () => [];
	lastSpoolOpts = undefined;
	vi.spyOn(process, "cwd").mockReturnValue("/repo");
	vi.spyOn(process.stdout, "write").mockImplementation((buf: string | Uint8Array) => {
		out += typeof buf === "string" ? buf : Buffer.from(buf).toString("utf-8");
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const DEFAULT_PATH = "/repo/.interlinked/offline-spool.jsonl";

// ===========================================
// Missing-spool guard
// ===========================================

describe("telemetryShowCommand — missing spool", () => {
	it("non-json: prints 'no spool at <default path>' and does not open the spool", async () => {
		existsImpl = () => false;
		await telemetryShowCommand({});
		expect(captured()).toBe(`[interlinked] no spool at ${DEFAULT_PATH}\n`);
		// readAll never called -> spool was never constructed.
		expect(lastSpoolOpts).toBeUndefined();
	});

	it("json: emits a single-line {ok:true, events:[], path}", async () => {
		existsImpl = () => false;
		await telemetryShowCommand({ json: true });
		const text = captured();
		expect(text.endsWith("\n")).toBe(true);
		const payload = parseWire(JSON.parse(text), wireObject({ "ok": wireBoolean, "events": wireArray(wireUnknown), "path": wireString }), "test JSON value");
		expect(payload).toEqual({ ok: true, events: [], path: DEFAULT_PATH });
		expect(lastSpoolOpts).toBeUndefined();
	});

	it("custom --spool path is honored (?? default not taken) and echoed back", async () => {
		existsImpl = () => false;
		await telemetryShowCommand({ spool: "/custom/spool.jsonl" });
		expect(captured()).toBe("[interlinked] no spool at /custom/spool.jsonl\n");
	});
});

// ===========================================
// Static read — text mode
// ===========================================

describe("telemetryShowCommand — static text output", () => {
	it("prints one padded line per event using the default spool path", async () => {
		readAllImpl = () => [
			ev({ kind: "hook_decision", session_id: "s1", decision: "allow" }),
			ev({ kind: "session_lifecycle", ts: "2026-04-23T00:00:01.000Z", session_id: "s1" }),
		];
		await telemetryShowCommand({});
		expect(lastSpoolOpts).toEqual({ spoolPath: DEFAULT_PATH });
		const text = captured();
		// hook_decision row: kind padded to 22, session to 20, then the decision.
		expect(text).toContain(`2026-04-23T00:00:00.000Z  ${"hook_decision".padEnd(22)} ${"s1".padEnd(20)} allow\n`);
		// session_lifecycle row: extra column empty (kind !== hook_decision arm).
		expect(text).toContain(`2026-04-23T00:00:01.000Z  ${"session_lifecycle".padEnd(22)} ${"s1".padEnd(20)} \n`);
	});

	it("hook_decision with no `decision` field renders an empty extra column (?? arm)", async () => {
		readAllImpl = () => [ev({ kind: "hook_decision", session_id: "s9" })];
		await telemetryShowCommand({});
		expect(captured()).toBe(
			`2026-04-23T00:00:00.000Z  ${"hook_decision".padEnd(22)} ${"s9".padEnd(20)} \n`,
		);
	});

	it("non-string session_id collapses to '-' placeholder", async () => {
		readAllImpl = () => [ev({ kind: "session_lifecycle", session_id: 12345 })];
		await telemetryShowCommand({});
		expect(captured()).toContain(` ${"-".padEnd(20)} \n`);
	});

	it("empty spool prints nothing in text mode", async () => {
		readAllImpl = () => [];
		await telemetryShowCommand({});
		expect(captured()).toBe("");
	});
});

// ===========================================
// Static read — json mode
// ===========================================

describe("telemetryShowCommand — static json output", () => {
	it("pretty-prints {ok, events, path} with the full event array", async () => {
		const events = [ev({ kind: "check_finding", session_id: "s2" })];
		readAllImpl = () => events;
		await telemetryShowCommand({ json: true });
		const text = captured();
		// Pretty-printed (2-space indent) -> contains newlines inside the object.
		expect(text).toContain('\n  "ok": true');
		const payload = parseWire(JSON.parse(text), wireObject({ "ok": wireBoolean, "events": wireArray(wireObject({ "schema": wireLiteral("v1"), "kind": wireLiteral("custom", "hook_decision", "check_finding", "session_lifecycle", "daemon_event", "suppression_applied", "daemon_fallback_cold", "budget_exceeded"), "ts": wireString })), "path": wireString }), "test JSON value");
		expect(payload.ok).toBe(true);
		expect(payload.path).toBe(DEFAULT_PATH);
		expect(payload.events).toHaveLength(1);
		expect(nonNull(payload.events[0]).kind).toBe("check_finding");
	});

	it("empty spool yields an empty events array in json mode", async () => {
		readAllImpl = () => [];
		await telemetryShowCommand({ json: true });
		const payload = parseWire(JSON.parse(captured()), wireObject({ "events": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.events).toEqual([]);
	});
});

// ===========================================
// --limit slicing (parseLimit + slice arms)
// ===========================================

describe("telemetryShowCommand — limit slicing", () => {
	function tenEvents(): SpoolEvent[] {
		return Array.from({ length: 10 }, (_, i) =>
			ev({ session_id: `s-${i}`, ts: `2026-04-23T00:00:${String(i).padStart(2, "0")}.000Z` }),
		);
	}

	it("valid --limit keeps the last N (slice(-limit)) preserving order", async () => {
		readAllImpl = tenEvents;
		await telemetryShowCommand({ limit: "3", json: true });
		const payload = parseWire(JSON.parse(captured()), wireObject({ "events": wireArray(wireObject({ "session_id": wireString })) }), "test JSON value");
		expect(payload.events.map((e) => e.session_id)).toEqual(["s-7", "s-8", "s-9"]);
	});

	it("no --limit returns the whole list (limit null -> no slice)", async () => {
		readAllImpl = tenEvents;
		await telemetryShowCommand({ json: true });
		const payload = parseWire(JSON.parse(captured()), wireObject({ "events": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.events).toHaveLength(10);
	});

	it("--limit 0 is treated as no limit (parseLimit -> null)", async () => {
		readAllImpl = tenEvents;
		await telemetryShowCommand({ limit: "0", json: true });
		const payload = parseWire(JSON.parse(captured()), wireObject({ "events": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.events).toHaveLength(10);
	});

	it("negative --limit is rejected (parseLimit n>0 guard -> null)", async () => {
		readAllImpl = tenEvents;
		await telemetryShowCommand({ limit: "-4", json: true });
		const payload = parseWire(JSON.parse(captured()), wireObject({ "events": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.events).toHaveLength(10);
	});

	it("non-numeric --limit is rejected (NaN -> null)", async () => {
		readAllImpl = tenEvents;
		await telemetryShowCommand({ limit: "abc", json: true });
		const payload = parseWire(JSON.parse(captured()), wireObject({ "events": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.events).toHaveLength(10);
	});
});

// ===========================================
// Follow mode (followSpool + handleLine)
// ===========================================
// followSpool's tail promise never resolves (intentional — it polls until the
// user ctrl-c's). We therefore do NOT await it; instead we await a microtask so
// the initial `await fs.stat` + optional initial print run, then fire the
// captured watchFile callback synchronously, assert, and abandon the pending
// poll promise. Each test cleans the watch handle in afterEach via restore.

describe("telemetryShowCommand — follow mode", () => {
	// Kick follow, let the dynamic import("node:fs/promises") + stat() + initial
	// print settle, then return so the test can drive the watcher. followSpool's
	// poll promise never resolves, so we poll for the watchFile install (the last
	// thing it does before awaiting forever) instead of awaiting the call.
	async function startFollow(opts: Parameters<typeof telemetryShowCommand>[0]): Promise<void> {
		void telemetryShowCommand(opts); // never resolves; fire-and-forget
		for (let i = 0; i < 50 && watchCb === null; i++) {
			await Promise.resolve();
		}
	}

	it("installs watchFile on the spool path at a 250ms interval", async () => {
		await startFollow({ follow: true });
		expect(watchedPath).toBe(DEFAULT_PATH);
		expect(watchOpts).toEqual({ interval: 250 });
		expect(typeof watchCb).toBe("function");
	});

	it("with a waitForever override, telemetryShowCommand({follow}) returns right after followSpool and never falls through to the static read", async () => {
		// In production the poll wait never resolves; `waitForever` is a
		// test-only hook so this call can be awaited directly to completion
		// (instead of via the fire-and-forget startFollow helper, which
		// never lets the call finish), exercising the early `return` right
		// after `await followSpool(...)` in telemetryShowCommand. Seed the
		// static-read fixture so that IF that `return;` were missing and
		// control fell through to the static path below it, the fallthrough
		// would be observable (a printed line + a constructed spool) rather
		// than silently indistinguishable from the correct early return.
		readAllImpl = () => [ev({ session_id: "static-fallthrough" })];
		let released: (() => void) | undefined;
		const promise = telemetryShowCommand({
			follow: true,
			waitForever: () =>
				new Promise<void>((resolve) => {
					released = resolve;
				}),
		});
		// followSpool suspends at its own internal awaits (the dynamic
		// import + fs.stat) before reaching the watcher install, so poll
		// microtasks until the release callback has been captured.
		for (let i = 0; i < 50 && released === undefined; i++) {
			await Promise.resolve();
		}
		expect(typeof released).toBe("function");
		released?.();
		// If telemetryShowCommand had NOT reached its `await followSpool(...)`
		// return path, this await would hang and the test would time out —
		// the literal assertion below only runs because it actually returned.
		await promise;
		expect(watchedPath).toBe(DEFAULT_PATH);
		// The observable the `return;` exists to produce: nothing printed and
		// the static-read spool never constructed. Deleting that `return;`
		// would let control fall through to the static path, which prints
		// the seeded "static-fallthrough" event and sets lastSpoolOpts.
		expect(captured()).toBe("");
		expect(lastSpoolOpts).toBeUndefined();
	});

	it("without --limit there is no initial print; the tail still reads on growth", async () => {
		statSize = 100; // seed lastSize so a smaller curr is ignored later
		await startFollow({ follow: true });
		// No initial events emitted (printInitial false).
		expect(captured()).toBe("");
		// Grow the file past the seed; the watcher reads from the seed offset.
		watchCb?.({ size: 180 });
		const stream = createdStreams.at(-1);
		expect(stream?.start).toBe(100);
		// Pump a valid line through the readline interface, then close it.
		const rl = createdInterfaces.at(-1);
		rl?.emitLine(JSON.stringify(ev({ session_id: "tailed" })));
		rl?.emitClose();
		const text = captured();
		expect(text).toContain("tailed");
		// close() balanced the stream on the readline 'close' event.
		expect(stream?.closed).toBe(true);
	});

	it("with --limit, the existing tail is printed once before watching (printInitial true)", async () => {
		statSize = 0;
		readAllImpl = () =>
			Array.from({ length: 5 }, (_, i) => ev({ session_id: `init-${i}` }));
		await startFollow({ follow: true, limit: "2" });
		const text = captured();
		// slice(-2) of the initial five.
		expect(text).toContain("init-3");
		expect(text).toContain("init-4");
		expect(text).not.toContain("init-0");
	});

	it("with --limit but a non-positive value, the initial print uses the full list (limit null arm)", async () => {
		readAllImpl = () => Array.from({ length: 3 }, (_, i) => ev({ session_id: `f-${i}` }));
		await startFollow({ follow: true, limit: "0" });
		const text = captured();
		expect(text).toContain("f-0");
		expect(text).toContain("f-1");
		expect(text).toContain("f-2");
	});

	it("a grow event whose size does not exceed lastSize is ignored (no read)", async () => {
		statSize = 200; // lastSize seeded at 200
		await startFollow({ follow: true });
		watchCb?.({ size: 200 }); // not greater -> guarded out
		expect(createdStreams).toHaveLength(0);
		expect(createdInterfaces).toHaveLength(0);
	});

	it("json follow mode writes the raw line back verbatim; text mode formats it", async () => {
		await startFollow({ follow: true, json: true });
		watchCb?.({ size: 50 });
		const rl = createdInterfaces.at(-1);
		const raw = JSON.stringify(ev({ session_id: "raw-tail", decision: "block" }));
		rl?.emitLine(raw);
		rl?.emitClose();
		// json arm prints the original line + a newline (not the padded form).
		expect(captured()).toBe(`${raw}\n`);
	});

	it("text follow mode formats the tailed event via printEventLine", async () => {
		await startFollow({ follow: true });
		watchCb?.({ size: 50 });
		const rl = createdInterfaces.at(-1);
		rl?.emitLine(JSON.stringify(ev({ session_id: "fmt", decision: "allow" })));
		rl?.emitClose();
		expect(captured()).toContain(
			`${"hook_decision".padEnd(22)} ${"fmt".padEnd(20)} allow\n`,
		);
	});

	it("handleLine skips: empty line, malformed JSON, JSON null, and non-object JSON", async () => {
		await startFollow({ follow: true });
		watchCb?.({ size: 50 });
		const rl = createdInterfaces.at(-1);
		rl?.emitLine(""); // empty -> early return
		rl?.emitLine("{not json"); // JSON.parse throws -> catch -> null
		rl?.emitLine("null"); // parses to null -> not object -> dropped
		rl?.emitLine("42"); // parses to number -> not object -> dropped
		rl?.emitClose();
		// Nothing should have been printed for any of those lines.
		expect(captured()).toBe("");
	});

	it("handleLine drops a line that parses to a non-object even in json mode", async () => {
		await startFollow({ follow: true, json: true });
		watchCb?.({ size: 50 });
		const rl = createdInterfaces.at(-1);
		rl?.emitLine('"a-bare-string"'); // valid JSON, typeof === string -> ev stays null
		rl?.emitClose();
		expect(captured()).toBe("");
	});

	it("a second growth event reads from the updated offset and appends more output", async () => {
		statSize = 0;
		await startFollow({ follow: true });
		// First growth.
		watchCb?.({ size: 30 });
		let rl = createdInterfaces.at(-1);
		rl?.emitLine(JSON.stringify(ev({ session_id: "first" })));
		rl?.emitClose();
		// Second growth starts where the first left off.
		watchCb?.({ size: 70 });
		const second = createdStreams.at(-1);
		expect(second?.start).toBe(30);
		rl = createdInterfaces.at(-1);
		rl?.emitLine(JSON.stringify(ev({ session_id: "second" })));
		rl?.emitClose();
		const text = captured();
		expect(text).toContain("first");
		expect(text).toContain("second");
	});

	it("honors a custom --spool path in follow mode", async () => {
		await startFollow({ follow: true, spool: "/tmp/custom-follow.jsonl" });
		expect(watchedPath).toBe("/tmp/custom-follow.jsonl");
	});
});
