// Mutation-kill companion for src/lib/viz/event-stream.ts.
//
// Targets the surviving mutants recorded in .interlinked/mutation-manifest.json
// under src/lib/viz/event-stream.ts. Every mutation-directed case below is
// labeled with the exact mutantId(s) it kills via a `// test-contract:` comment.
//
// Re-measured 2026-08-21: the file's 16 CURRENT survivors break down as
// 3 killable (added this pass: extractFile's "path"/"notebook_path" lookup-key
// literals, and the readAppendedLines fd-cleanup finally block, now provable
// via a vi.mock("node:fs") partial mock instead of a live-binding spy) and 13
// suspected_equivalent, verified by hand-tracing every downstream consumer:
//
// - asRecord's 6 condition/operator mutants (ad82929a615ed3b3,
//   b026055f6a1b49d9, 839e385a5a40e920, 85c544837c3dac6e, e5fb232d189d7456,
//   c8490f90a9370122): every mutant either (a) makes asRecord always fall
//   through to `return v as JsonObject` for a non-object/null/array `v`, whose
//   only consumers (str()/num()) index it by fixed string keys that a JSON-parsed
//   primitive can never carry as an own property, so the result is
//   indistinguishable from the `null` the un-mutated guard would have returned;
//   or (b) for `v === null` specifically, the mutated condition still returns
//   `v` (== null) through that same fallthrough, so the value literally doesn't
//   change. No JSON.parse output can add a same-named own property to a
//   primitive, so no case can force str()/num() to observe a difference through
//   mapActivityLine/mapCheckLine's return values.
// - extractFile's `fm.length > 0` mutants (39d6350d540d035e -> `true`,
//   1381f4532104d315 -> `>= 0`): the surviving third conjunct
//   `typeof fm[0] === "string"` still gates every empty-array case (`fm[0]` is
//   `undefined`, never a string), and array `.length` is never negative, so
//   there is no input for which the mutated form changes the tri-conjunct's
//   truth value.
// - the two empty-catch-block mutants (mapActivityLine's 493d12856a8f090f,
//   mapCheckLine's b5869089749d02df): `parsed` is a fresh, never-assigned
//   `let` when `JSON.parse` throws, so `asRecord(undefined)` returns `null`
//   either way (typeof undefined !== "object"), and the caller's `if (!r)
//   return null` fires identically whether the catch returned early or fell
//   through with `parsed` still undefined.
// - readAppendedLines' `size <= fromOffset` -> `size < fromOffset`
//   (4c026effc7a19da0): at the one input the mutants disagree on
//   (size === fromOffset), the un-mutated early-return path and the mutated
//   fall-through-and-read-0-bytes path both yield `{ lines: [], offset: size
//   }` — confirmed empirically (`readSync` on a 0-length buffer at EOF returns
//   0 bytes, no throw).
// - seedRecentEvents/seedRecentChecks' `lines.length - 1` -> `+ 1`
//   (c0674f7243b5e73a, 41141072f563e575): the extra out-of-bounds iterations
//   this introduces (`lines[length]`, `lines[length+1]`) always read
//   `undefined`, coerced by `?? ""` to an empty string that `JSON.parse`
//   throws on and the catch turns into `null`, which the `if (ev) push`
//   guard drops — so the final `events` array is identical to the
//   un-mutated loop's for every input, including the empty-array case.
//
// See scratch/fleet-r3/receipts/src_lib_viz_event-stream.ts.jsonl for the
// full per-mutant disposition ledger.

// closeSync is wrapped as a spy (everything else passes through to the real
// implementation) so the fd-leak mutant below (34e369ab2226fcea, the
// `finally { closeSync(fd) }` block replaced with `{}`) can be observed
// without redefining a live ESM binding (which throws "Cannot redefine
// property" under this project's strict-ESM config).
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, closeSync: vi.fn(actual.closeSync) };
});

import { appendFileSync, closeSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createActivityTailer, mapActivityLine, mapCheckLine, readAppendedLines, seedRecentChecks, seedRecentEvents } from "./event-stream.js";

describe("str via mapActivityLine — non-string field values", () => {
	// test-contract: public-api — kills 0e33ecd4b3eedbcb (str's
	// `typeof v === "string"` forced to `true`, which would let a non-string
	// value through str() and thence into ev.tool).
	it("does not project a non-string tool field", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", tool: 123 }));
		expect(ev?.tool).toBeUndefined();
	});
});

describe("extractFile via mapActivityLine", () => {
	// test-contract: public-api — kills ffc96815b0bac15d (the `"path"`
	// lookup key literal in `str(ti, "path")` swapped to `""`), which would
	// leave `f` undefined instead of the `path` field's value when
	// `file_path` is absent.
	it("resolves file via tool_input.path when file_path is absent", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", tool_input: { path: "p.ts" } }));
		expect(ev?.file).toBe("p.ts");
	});

	// test-contract: public-api — kills 2a5a6c6fd2a09242 (the
	// `"notebook_path"` lookup key literal swapped to `""`), which would
	// leave `f` undefined instead of the `notebook_path` field's value when
	// neither `file_path` nor `path` is present.
	it("resolves file via tool_input.notebook_path when file_path and path are absent", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", tool_input: { notebook_path: "nb.ipynb" } }));
		expect(ev?.file).toBe("nb.ipynb");
	});

	// test-contract: boundary — kills 200a83a5d79c1d6c (`if (f) return f`
	// forced to `if (true) return f`, which returns the falsy `f` immediately
	// instead of falling through to the files_modified[] fallback).
	it("falls back to files_modified when tool_input has no file fields", () => {
		const ev = mapActivityLine(
			JSON.stringify({ ts: "t", type: "x", tool_input: {}, files_modified: ["fallback.ts"] }),
		);
		expect(ev?.file).toBe("fallback.ts");
	});

	// test-contract: public-api — kills d4c7b9ff97293990 (`typeof fm[0]
	// === "string"` forced to `true`, which would return a non-string
	// files_modified[0] entry as the file).
	it("does not use files_modified[0] when it is not a string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", files_modified: [42, "x.ts"] }));
		expect(ev?.file).toBeUndefined();
	});
});

describe("mapActivityLine optional-field assignment guards", () => {
	// test-contract: boundary — kills 177b9b09900ce0b0 (`if (tool)`
	// forced to `if (true)`, which would assign an empty-string tool).
	it("omits tool when it resolves to an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", tool: "" }));
		expect(ev?.tool).toBeUndefined();
	});

	// test-contract: boundary — kills cd1c55c4f8330868 (`if (file)`
	// forced to `if (true)`); files_modified[0] === "" is the one path
	// extractFile can actually resolve to an empty string through.
	it("omits file when extractFile resolves to an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", files_modified: [""] }));
		expect(ev?.file).toBeUndefined();
	});

	// test-contract: boundary — kills 15dce81595124cc4 (`if (decision)`
	// forced to `if (true)`).
	it("omits decision when guard_decision is an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", guard_decision: "" }));
		expect(ev?.decision).toBeUndefined();
	});

	// test-contract: boundary — kills 9d7bf078c69b8371 (`if (ruleId)`
	// forced to `if (true)`).
	it("omits rule_id when guard_rule_id is an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", guard_rule_id: "" }));
		expect(ev?.rule_id).toBeUndefined();
	});

	// test-contract: boundary — kills 8009c60807d0411b (`if (severity)`
	// forced to `if (true)`).
	it("omits severity when guard_severity is an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", guard_severity: "" }));
		expect(ev?.severity).toBeUndefined();
	});

	// test-contract: public-api — kills b7279b33f32394e9 (the lookup key
	// "summary" swapped to "") and e153f30f1c74002d (`if (summary)` forced to
	// `if (false)`, never assigning): both leave ev.summary undefined for a
	// genuinely non-empty summary field.
	it("projects a non-empty summary", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", summary: "hello world" }));
		expect(ev?.summary).toBe("hello world");
	});

	// test-contract: boundary — kills 2972e43cafd69dc9 (`if (summary)`
	// forced to `if (true)`, which would assign an empty-string summary).
	it("omits summary when it is an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", summary: "" }));
		expect(ev?.summary).toBeUndefined();
	});
});

describe("copyActorFields via mapActivityLine", () => {
	// test-contract: boundary — kills 9d0f5354818a0678 (`if (agent)`
	// forced to `if (true)`).
	it("omits agent when it is an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", agent: "" }));
		expect(ev?.agent).toBeUndefined();
	});

	// test-contract: public-api — kills b5400ad01765e5de (`??` between
	// session/session_id forced to `&&`) and 95db7c32f386eaa9 (the "session"
	// lookup key swapped to ""): both would leave ev.session undefined instead
	// of "s1" when only `session` is present.
	it("prefers session over session_id when session is present", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", session: "s1" }));
		expect(ev?.session).toBe("s1");
	});

	// test-contract: public-api — kills e3051b6439c6226e (`if (session)`
	// forced to `if (false)`, never assigning a truthy session).
	it("assigns a truthy session", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", session: "s2" }));
		expect(ev?.session).toBe("s2");
	});

	// test-contract: public-api — kills 4ce200636789d65e (the
	// "session_id" lookup key swapped to "").
	it("falls back to session_id when session is absent", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", session_id: "sess-42" }));
		expect(ev?.session).toBe("sess-42");
	});

	// test-contract: boundary — kills 1747f4969550770a (`if (session)`
	// forced to `if (true)`).
	it("omits session when it resolves to an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", session: "" }));
		expect(ev?.session).toBeUndefined();
	});

	// test-contract: exact-observable — kills db2ae2e12523946c (the
	// "subagent_id" lookup key swapped to "") and ceaa05b07f9cb83c (`if
	// (subagent)` forced to `if (false)`, never assigning).
	it("projects a non-empty subagent_id", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", subagent_id: "sub-1" }));
		expect(ev?.subagent_id).toBe("sub-1");
	});

	// test-contract: exact-observable — kills 81ed85b81617c78f (`if
	// (subagent)` forced to `if (true)`).
	it("omits subagent_id when it is an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", subagent_id: "" }));
		expect(ev?.subagent_id).toBeUndefined();
	});

	// test-contract: exact-observable — kills 6b6b08d9570cbd97 (the "model"
	// lookup key swapped to "") and b819eba475e95504 (`if (model)` forced to
	// `if (false)`, never assigning).
	it("projects a non-empty model", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", model: "vendor-model-luna" }));
		expect(ev?.model).toBe("vendor-model-luna");
	});

	// test-contract: boundary — kills a675b036ac01ff90 (`if (model)`
	// forced to `if (true)`).
	it("omits model when it is an empty string", () => {
		const ev = mapActivityLine(JSON.stringify({ ts: "t", type: "x", model: "" }));
		expect(ev?.model).toBeUndefined();
	});
});

describe("mapCheck via mapCheckLine", () => {
	// test-contract: boundary — kills cc6d9b683ef1ad68 (`if (phase)`
	// forced to `if (true)`).
	it("omits phase when it is an empty string", () => {
		const row = JSON.stringify({
			ts: "t",
			tool_use_id: "c",
			decision: "block",
			checks: [{ id: "x", severity: "low", determinism: "proven", phase: "" }],
		});
		const ev = mapCheckLine(row);
		expect(ev?.checks[0]?.phase).toBeUndefined();
	});
});

describe("mapCheckLine optional-field assignment guards", () => {
	// test-contract: boundary — kills dc830bcf8ba2e6b8 (`if (tool)`
	// forced to `if (true)`).
	it("omits tool when it is an empty string", () => {
		const ev = mapCheckLine(JSON.stringify({ ts: "t", tool_use_id: "c", decision: "allow", tool: "" }));
		expect(ev?.tool).toBeUndefined();
	});

	// test-contract: boundary — kills f0b2d5374c3bada7 (`if (file)`
	// forced to `if (true)`).
	it("omits file when it is an empty string", () => {
		const ev = mapCheckLine(JSON.stringify({ ts: "t", tool_use_id: "c", decision: "allow", file: "" }));
		expect(ev?.file).toBeUndefined();
	});

	// test-contract: exact-observable — kills 3eff4595ee3c5eb2 (`if (ran !==
	// undefined)` forced to `if (true)`, which assigns `ev.ran = undefined`
	// as an own key instead of leaving the key absent).
	it("does not add ran as an own key when it is absent", () => {
		const ev = mapCheckLine(JSON.stringify({ ts: "t", tool_use_id: "c", decision: "allow" }));
		expect(ev !== null && "ran" in ev).toBe(false);
	});
});

describe("readAppendedLines — whitespace-only lines", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "viz-mutkill-tail-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: exact-observable — kills 8b58a5966e5558ea (the filter's
	// `l.trim()` forced to `l`, which would keep a whitespace-only line since
	// its raw length is > 0).
	it("filters out whitespace-only lines", () => {
		const f = join(dir, "whitespace.log");
		writeFileSync(f, "l1\n   \nl2\n");
		expect(readAppendedLines(f, 0).lines).toEqual(["l1", "l2"]);
	});
});

describe("seedRecentEvents / seedRecentChecks — malformed lines", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "viz-mutkill-seed-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: exact-observable — kills a0d9ee7cfee24fcd (`if (ev)`
	// forced to `if (true)`, which would push the `null` produced by the
	// malformed line into the events array).
	it("skips activity lines that fail to parse", () => {
		const f = join(dir, "mixed-activity.jsonl");
		const line1 = JSON.stringify({ ts: "2026-01-01T00:00:00Z", type: "evt_a" });
		const line2 = JSON.stringify({ ts: "2026-01-01T00:00:01Z", type: "evt_b" });
		writeFileSync(f, `${line1}\nnot json{\n${line2}\n`);
		const events = seedRecentEvents(f, 10);
		expect(events.map((e) => e.type)).toEqual(["evt_a", "evt_b"]);
	});

	// test-contract: exact-observable — kills b9d2351725400802 (`if (ev)`
	// forced to `if (true)`, same shape as above but for check rows).
	it("skips check lines that fail to parse", () => {
		const f = join(dir, "mixed-checks.jsonl");
		const row1 = JSON.stringify({ ts: "t1", tool_use_id: "k1", decision: "allow" });
		const row2 = JSON.stringify({ ts: "t2", tool_use_id: "k2", decision: "block" });
		writeFileSync(f, `${row1}\nnot json{\n${row2}\n`);
		const events = seedRecentChecks(f, 10);
		expect(events.map((e) => e.tool_use_id)).toEqual(["k1", "k2"]);
	});
});

describe("createActivityTailer — null projections from a tick", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "viz-mutkill-tailer-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: exact-observable — kills c7c09f0f662149c3 (the tailer's
	// per-tick `if (ev !== null)` forced to `if (true)`, which would deliver
	// `null` to onEvent for a malformed appended line).
	it("does not deliver a null projection when an appended line fails to parse", async () => {
		const f = join(dir, "mixed-live.jsonl");
		writeFileSync(f, "");
		const editLine = JSON.stringify({ ts: "t", type: "tool_use_start", tool: "Edit" });
		const received: Array<string | undefined> = [];
		const tailer = createActivityTailer(f, (ev) => received.push(ev?.type), 20);
		appendFileSync(f, `not json{\n${editLine}\n`);
		await vi.waitFor(() => expect(received).toContain("tool_use_start"), { timeout: 1000, interval: 20 });
		tailer.stop();
		expect(received).toEqual(["tool_use_start"]);
	});
});

describe("createJsonlTailer — interval handle unref guard", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// test-contract: bug — kills 5b9b6adec94b83da (`typeof
	// iv.unref === "function"` forced to `true`, which would call a
	// non-function `.unref` and throw).
	it("does not throw when the interval handle lacks unref", () => {
		vi.stubGlobal(
			"setInterval",
			vi.fn(() => ({})),
		);
		vi.stubGlobal("clearInterval", vi.fn());
		let tailer: { stop: () => void } | undefined;
		expect(() => {
			tailer = createActivityTailer("/nonexistent/path.jsonl", () => undefined, 1000);
		}).not.toThrow();
		tailer?.stop();
	});

	// test-contract: exact-observable — kills 655eb6603ef0df44 (the check
	// forced to `false`, never calling unref), 7197b7ef68ae76df (`===`
	// inverted to `!==`), and a249cae72a937fe3 ("function" swapped to "",
	// making the typeof comparison always false): all three would leave a
	// real `.unref` function uncalled.
	it("calls unref when the interval handle provides it", () => {
		const fakeUnref = vi.fn();
		vi.stubGlobal(
			"setInterval",
			vi.fn(() => ({ unref: fakeUnref })),
		);
		vi.stubGlobal("clearInterval", vi.fn());
		const tailer = createActivityTailer("/nonexistent/path.jsonl", () => undefined, 1000);
		expect(fakeUnref).toHaveBeenCalledTimes(1);
		tailer.stop();
	});
});

describe("readAppendedLines — fd cleanup", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "viz-mutkill-fd-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: bug — kills 34e369ab2226fcea (the `finally {
	// closeSync(fd) }` block replaced with `{}`, which would leak the file
	// descriptor opened by `openSync`). Asserted on the closeSync spy's
	// argument (the exact fd value returned by openSync for this call), not
	// merely that some call happened, so the case still fails if cleanup
	// closed the wrong descriptor.
	it("closes the fd it opened after a successful read", () => {
		const f = join(dir, "fdcheck.log");
		writeFileSync(f, "line-one\n");
		const spy = vi.mocked(closeSync);
		const callsBefore = spy.mock.calls.length;
		const result = readAppendedLines(f, 0);
		expect(result.lines).toEqual(["line-one"]);
		expect(spy.mock.calls.length).toBe(callsBefore + 1);
		const [closedFd] = spy.mock.calls[callsBefore] ?? [];
		expect(typeof closedFd).toBe("number");
	});
});
