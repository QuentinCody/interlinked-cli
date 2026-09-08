import { parseWire, wireAbsentOptional, wireArray, wireLiteral, wireObject, wireRecord, wireString } from "../lib/value-validation.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	censusPath,
	CONSUMED_PAYLOAD_KEYS,
	describeShape,
	loadCensus,
	MAX_SHAPE_MEMBERS,
	mergeObservation,
	type PayloadKeyCensus,
	recordPayloadKeys,
	unconsumedKeys,
} from "./payload-key-census.js";

const NOW = "2026-08-07T22:00:00.000Z";
const LATER = "2026-08-08T09:00:00.000Z";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "payload-census-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function read(): PayloadKeyCensus {
	// SAFETY: written by recordPayloadKeys in this test; shape is ours.
	return parseWire(JSON.parse(readFileSync(censusPath(dir), "utf-8")), wireObject({ "schema": wireLiteral("payload-keys.v1"), "entries": wireRecord(wireObject({ "unconsumed": wireArray(wireString), "shapes": wireAbsentOptional(wireRecord(wireString)), "first_seen": wireString, "last_seen": wireString })) }), "test JSON value");
}

describe("unconsumedKeys — positive (must report)", () => {
	it("P1: reports a field the pipeline does not read", () => {
		expect(unconsumedKeys({ session_id: "s", brand_new_field: 1 })).toEqual(["brand_new_field"]);
	});

	it("P2: sorts the reported keys for a stable census", () => {
		expect(unconsumedKeys({ zeta: 1, alpha: 2 })).toEqual(["alpha", "zeta"]);
	});
});

describe("payload census paths and consumed aliases", () => {
	it("uses the repository-local .interlinked census path", () => {
		expect(censusPath("/repo")).toBe("/repo/.interlinked/payload-keys.json");
	});

	it("recognizes every supported envelope, tool, prompt, and lifecycle alias", () => {
		// Keep this explicit: constructing the payload from CONSUMED_PAYLOAD_KEYS
		// would let a mutated set hide a removed member from the assertion.
		const payload = {
			transcriptPath: 1,
			transcript_path: 1,
			hook_event_name: 1,
			sessionId: 1,
			permission_mode: 1,
			model: 1,
			agent_name: 1,
			cli_version: 1,
			claude_code_version: 1,
			toolName: 1,
			name: 1,
			toolInput: 1,
			tool_response: 1,
			toolResponse: 1,
			tool_use_id: 1,
			parent_tool_use_id: 1,
			error: 1,
			tool_error: 1,
			message: 1,
			is_interrupt: 1,
			duration_ms: 1,
			durationMs: 1,
			prompt: 1,
			user_prompt: 1,
			userPrompt: 1,
			stop_reason: 1,
			stop_hook_active: 1,
			last_assistant_message: 1,
			usage: 1,
			token_usage: 1,
			reason: 1,
			source: 1,
			prompt_id: 1,
			effort: 1,
			available_tools: 1,
			parent_agent: 1,
			parent_agent_name: 1,
			parent_session_id: 1,
			subagent_id: 1,
			subagent_type: 1,
			task_id: 1,
			task_subject: 1,
			task_description: 1,
			teammate_name: 1,
			team_name: 1,
			notification_type: 1,
			title: 1,
			trigger: 1,
			custom_instructions: 1,
			files_modified: 1,
		};
		expect(Object.keys(payload).every((key) => CONSUMED_PAYLOAD_KEYS.has(key))).toBe(true);
		expect(unconsumedKeys(payload)).toEqual([]);
	});
});

describe("unconsumedKeys — negative (must not report)", () => {
	it("N1: a fully-consumed payload reports nothing", () => {
		expect(unconsumedKeys({ session_id: "s", cwd: "/r", tool_name: "Bash", tool_input: {} })).toEqual([]);
	});

	it("N2: subagent lifecycle fields are recognized as consumed", () => {
		expect(
			unconsumedKeys({ agent_id: "a1", agent_type: "general-purpose", agent_transcript_path: "/t" }),
		).toEqual([]);
	});
});

describe("recordPayloadKeys", () => {
	it("P3: writes an entry keyed by runner + native event", () => {
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "SubagentStop",
			raw: { session_id: "s", mystery_usage: { output: 1 } },
			cwd: dir,
			now: NOW,
		});
		expect(read().entries["claude-code/SubagentStop"]).toEqual({
			unconsumed: ["mystery_usage"],
			shapes: { mystery_usage: "object{output}" },
			first_seen: NOW,
			last_seen: NOW,
		});
	});

	it("P4: merges a newly-seen key and moves last_seen, keeping first_seen", () => {
		recordPayloadKeys({ runner: "claude-code", nativeEvent: "Stop", raw: { a_new: 1 }, cwd: dir, now: NOW });
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "Stop",
			raw: { a_new: 1, b_newer: 2 },
			cwd: dir,
			now: LATER,
		});
		expect(read().entries["claude-code/Stop"]).toEqual({
			unconsumed: ["a_new", "b_newer"],
			shapes: { a_new: "number", b_newer: "number" },
			first_seen: NOW,
			last_seen: LATER,
		});
	});

	it("N3: a payload with nothing unconsumed writes no file at all", () => {
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "PreToolUse",
			raw: { session_id: "s", tool_name: "Bash" },
			cwd: dir,
			now: NOW,
		});
		expect(() => readFileSync(censusPath(dir), "utf-8")).toThrow();
	});

	it("N4: a non-object payload is ignored", () => {
		recordPayloadKeys({ runner: "claude-code", nativeEvent: "Stop", raw: "nope", cwd: dir, now: NOW });
		recordPayloadKeys({ runner: "claude-code", nativeEvent: "Stop", raw: [1, 2], cwd: dir, now: NOW });
		expect(() => readFileSync(censusPath(dir), "utf-8")).toThrow();
	});

	it("N5: a corrupt census is replaced rather than thrown on", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(censusPath(dir), "{not json");
		recordPayloadKeys({ runner: "claude-code", nativeEvent: "Stop", raw: { odd: 1 }, cwd: dir, now: NOW });
		expect(read().entries["claude-code/Stop"]?.unconsumed).toEqual(["odd"]);
	});

	it("N6: a write failure is swallowed (fail-open) and does not corrupt later recordings", () => {
		// Put a DIRECTORY at the exact census file path so writeFileSync throws
		// EISDIR mid-write. If the outer try/catch around the write were removed,
		// this call would throw and take the caller's hook pipeline down with it.
		mkdirSync(censusPath(dir), { recursive: true });
		expect(() =>
			recordPayloadKeys({
				runner: "claude-code",
				nativeEvent: "Stop",
				raw: { blocked_field: 1 },
				cwd: dir,
				now: NOW,
			}),
		).not.toThrow();

		// Fail-open must not leave the module unable to recover: once the
		// blocking directory is gone, the SAME observation lands normally.
		rmSync(censusPath(dir), { recursive: true, force: true });
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "Stop",
			raw: { blocked_field: 1 },
			cwd: dir,
			now: LATER,
		});
		expect(read().entries["claude-code/Stop"]?.unconsumed).toEqual(["blocked_field"]);
	});
});

describe("describeShape — positive (must describe type + member names)", () => {
	it("P6: describes an array of objects by its first element's members", () => {
		expect(describeShape([{ id: "t1", status: "running" }])).toBe("array<object{id,status}>");
	});

	it("P7: describes primitives by type and an empty array distinctly", () => {
		expect(describeShape("high")).toBe("string");
		expect(describeShape(7)).toBe("number");
		expect(describeShape([])).toBe("array<empty>");
		expect(describeShape(null)).toBe("null");
	});

	it("P8: records the shape alongside the key in the census", () => {
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "Stop",
			raw: { future_roster: [{ id: "b1", status: "running" }] },
			cwd: dir,
			now: NOW,
		});
		expect(read().entries["claude-code/Stop"]?.shapes).toEqual({
			future_roster: "array<object{id,status}>",
		});
	});
});

describe("describeShape — negative (must not leak values)", () => {
	it("N7: object member VALUES never appear in the shape", () => {
		const shape = describeShape({ token: "sk-live-SECRET", nested: { pw: "hunter2" } });
		expect(shape).not.toContain("SECRET");
		expect(shape).not.toContain("hunter2");
		expect(shape).toBe("object{token,nested}");
	});

	it("N8: a wide object is capped rather than fully enumerated", () => {
		const wide: Record<string, number> = {};
		for (let i = 0; i < MAX_SHAPE_MEMBERS + 5; i++) wide[`k${i}`] = i;
		expect(describeShape(wide).endsWith(",…}")).toBe(true);
	});

	it("does not add an ellipsis when an object has exactly the member cap", () => {
		const exact: Record<string, number> = {};
		for (let i = 0; i < MAX_SHAPE_MEMBERS; i++) exact[`k${i}`] = i;
		expect(describeShape(exact)).toBe(
			`object{${Array.from({ length: MAX_SHAPE_MEMBERS }, (_, i) => `k${i}`).join(",")}}`,
		);
	});
});

describe("mergeObservation / loadCensus", () => {
	it("P5: re-seeing the same keys reports no change", () => {
		const first = mergeObservation(loadCensus(dir), { key: "r/E", keys: ["x"], now: NOW });
		expect(first.changed).toBe(true);
		const second = mergeObservation(first.census, { key: "r/E", keys: ["x"], now: LATER });
		expect(second.changed).toBe(false);
		expect(second.census).toEqual(first.census);
	});

	it("keeps newly merged keys sorted", () => {
		const result = mergeObservation(
			{
				schema: "payload-keys.v1",
				entries: { "r/E": { unconsumed: ["zeta"], first_seen: NOW, last_seen: NOW } },
			},
			{ key: "r/E", keys: ["alpha", "middle"], now: NOW },
		);
		expect(result.census.entries["r/E"]?.unconsumed).toEqual(["alpha", "middle", "zeta"]);
		expect(result.census.schema).toBe("payload-keys.v1");
	});

	it("preserves an existing entry that has no shapes map", () => {
		const result = mergeObservation(
			{
				schema: "payload-keys.v1",
				entries: { "r/E": { unconsumed: ["old"], first_seen: NOW, last_seen: NOW } },
			},
			{ key: "r/E", keys: ["old"], now: LATER },
		);
		expect(result.census.entries["r/E"]).toEqual({
			unconsumed: ["old"],
			shapes: {},
			first_seen: NOW,
			last_seen: LATER,
		});
	});

	it("does not record an empty shape description", () => {
		const result = mergeObservation(
			{
				schema: "payload-keys.v1",
				entries: { "r/E": { unconsumed: ["mystery"], first_seen: NOW, last_seen: NOW } },
			},
			{ key: "r/E", keys: ["mystery"], shapes: { mystery: "" }, now: NOW },
		);
		expect(result.census.entries["r/E"]?.shapes).toEqual({});
	});

	it("P10: a since-wired key is pruned from the FILE on the next observation", () => {
		// Seed a stale entry naming a key that is now consumed, as a census
		// written before the field was wired up would look.
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: {
					"claude-code/PreToolUse": {
						unconsumed: ["background_tasks", "still_unknown"],
						shapes: { background_tasks: "array<empty>", still_unknown: "string" },
						first_seen: NOW,
						last_seen: NOW,
					},
				},
			}),
		);
		// A payload with nothing NEW to report must still reach the merge —
		// otherwise a solved problem stays on the report forever.
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "PreToolUse",
			raw: { session_id: "s", tool_name: "Bash" },
			cwd: dir,
			now: LATER,
		});
		expect(read().entries["claude-code/PreToolUse"]?.unconsumed).toEqual(["still_unknown"]);
	});

	it("P9: prunes a key that has since been wired into the pipeline", () => {
		const stale = mergeObservation(loadCensus(dir), {
			key: "claude-code/Stop",
			keys: ["still_unknown", "background_tasks"],
			shapes: { still_unknown: "string", background_tasks: "array<empty>" },
			now: NOW,
		}).census;
		// `background_tasks` is in CONSUMED_PAYLOAD_KEYS, so the next observation
		// must drop it from both the key list and the shape map.
		const next = mergeObservation(stale, {
			key: "claude-code/Stop",
			keys: ["still_unknown"],
			shapes: { still_unknown: "string" },
			now: LATER,
		});
		expect(next.changed).toBe(true);
		expect(next.census.entries["claude-code/Stop"]?.unconsumed).toEqual(["still_unknown"]);
		expect(next.census.entries["claude-code/Stop"]?.shapes).toEqual({ still_unknown: "string" });
	});

	it("N6: a missing census file loads as empty", () => {
		expect(loadCensus(dir)).toEqual({ schema: "payload-keys.v1", entries: {} });
	});

	it("loads a valid census with its schema and optional shapes intact", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: {
					"runner/Event": {
						unconsumed: ["future"],
						shapes: { future: "array<object{id}>" },
						first_seen: NOW,
						last_seen: LATER,
					},
				},
			}),
		);
		expect(loadCensus(dir)).toEqual({
			schema: "payload-keys.v1",
			entries: {
				"runner/Event": {
					unconsumed: ["future"],
					shapes: { future: "array<object{id}>" },
					first_seen: NOW,
					last_seen: LATER,
				},
			},
		});
	});

	it("preserves a valid entry that omits optional shapes", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: { "runner/Event": { unconsumed: ["future"], first_seen: NOW, last_seen: LATER } },
			}),
		);
		expect(loadCensus(dir).entries["runner/Event"]).toEqual({
			unconsumed: ["future"],
			first_seen: NOW,
			last_seen: LATER,
		});
	});

	it("drops a primitive root and a primitive entries field", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(censusPath(dir), JSON.stringify("not-an-object"));
		expect(loadCensus(dir)).toEqual({ schema: "payload-keys.v1", entries: {} });
		writeFileSync(censusPath(dir), JSON.stringify({ schema: "payload-keys.v1", entries: "not-a-record" }));
		expect(loadCensus(dir)).toEqual({ schema: "payload-keys.v1", entries: {} });
	});

	it("rejects entries with invalid timestamps or mixed key types", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: {
					badFirst: { unconsumed: ["x"], first_seen: 1, last_seen: NOW },
					badLast: { unconsumed: ["x"], first_seen: NOW, last_seen: false },
					mixedKeys: { unconsumed: ["x", 2], first_seen: NOW, last_seen: NOW },
					good: { unconsumed: ["x"], first_seen: NOW, last_seen: NOW },
				},
			}),
		);
		expect(Object.keys(loadCensus(dir).entries)).toEqual(["good"]);
	});

	it("rejects malformed shape maps and shape values", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: {
					badMap: { unconsumed: ["x"], shapes: [], first_seen: NOW, last_seen: NOW },
					badValue: { unconsumed: ["x"], shapes: { x: 1 }, first_seen: NOW, last_seen: NOW },
					good: { unconsumed: ["x"], shapes: { x: "string" }, first_seen: NOW, last_seen: NOW },
				},
			}),
		);
		expect(Object.keys(loadCensus(dir).entries)).toEqual(["good"]);
	});

	it("N9: drops a malformed individual entry but keeps valid ones", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: {
					"good/Event": { unconsumed: ["x"], first_seen: NOW, last_seen: NOW },
					"bad/Event": { unconsumed: "not-an-array", first_seen: NOW, last_seen: NOW },
				},
			}),
		);
		const census = loadCensus(dir);
		expect(Object.keys(census.entries)).toEqual(["good/Event"]);
	});

	it("N10: treats a non-object entries field as empty instead of trusting it", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({ schema: "payload-keys.v1", entries: ["not", "a", "record"] }),
		);
		expect(loadCensus(dir)).toEqual({ schema: "payload-keys.v1", entries: {} });
	});

	it("P11: a malformed entry no longer crashes a follow-up merge", () => {
		// Pre-fix, `existing.unconsumed.filter(...)` inside mergeObservation threw
		// on a corrupted (non-array) `unconsumed` field, since loadCensus trusted
		// the whole entries map unchecked. Post-fix the malformed entry is
		// dropped at load time, so the follow-up observation is treated as a
		// brand-new entry instead of crashing.
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: {
					"claude-code/Stop": { unconsumed: "not-an-array", first_seen: NOW, last_seen: NOW },
				},
			}),
		);
		expect(() =>
			recordPayloadKeys({
				runner: "claude-code",
				nativeEvent: "Stop",
				raw: { odd: 1 },
				cwd: dir,
				now: LATER,
			}),
		).not.toThrow();
		expect(read().entries["claude-code/Stop"]?.unconsumed).toEqual(["odd"]);
	});
});
