// Mutation-hardening tests for recurrence.ts (Campaign A, 2026-10-21).
// Each test pins a behavior that a single-change mutant of the module
// survived under recurrence.test.ts. Basis for each is cited inline.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	aggregateRecurrences,
	loadRecurrenceEvents,
	proposeAction,
	type Recurrence,
	type RecurrenceEvent,
	recordHarnessCaught,
} from "../recurrence.js";

function ev(overrides: Partial<RecurrenceEvent> = {}): RecurrenceEvent {
	return {
		ts: "2026-05-01T00:00:00.000Z",
		kind: "harness_missed",
		signature: "s",
		session_id: "s1",
		file: "src/foo.ts",
		agent_source: "claude",
		...overrides,
	};
}

function row(overrides: Partial<Recurrence>): Recurrence {
	return {
		kind: "harness_caught",
		signature: "harness_caught:foo:claude",
		check_id: "foo",
		count: 5,
		first_seen: "2026-05-01T00:00:00.000Z",
		last_seen: "2026-05-03T00:00:00.000Z",
		distinct_sessions: 3,
		distinct_files: 2,
		agent_sources: ["claude"],
		sample_files: ["a.ts", "b.ts"],
		assembly_significance: 0,
		...overrides,
	};
}

describe("aggregateRecurrences — absent-value handling", () => {
	// recurrence.ts:161-163 guard these fields with a truthiness check.
	it("does not count an empty session_id as a distinct session", () => {
		const [r] = aggregateRecurrences([ev({ session_id: "" }), ev({ session_id: "s1" })]);
		expect(nonNull(r).distinct_sessions).toBe(1);
	});

	it("does not count an empty file as a distinct file or sample file", () => {
		const [r] = aggregateRecurrences([ev({ file: "" })]);
		expect(nonNull(r).distinct_files).toBe(0);
		expect(nonNull(r).sample_files).toEqual([]);
	});

	it("does not list an empty agent_source in agent_sources", () => {
		const [r] = aggregateRecurrences([ev({ agent_source: "" }), ev({ agent_source: "codex" })]);
		expect(nonNull(r).agent_sources).toEqual(["codex"]);
	});
});

describe("aggregateRecurrences — ordering and bounds", () => {
	// recurrence.ts:193-194: "Signature breaks any remaining tie for stable output."
	it("breaks count and significance ties by ascending signature, whatever the input order", () => {
		const a = ev({ signature: "pat-a" });
		const b = ev({ signature: "pat-b" });
		const forward = aggregateRecurrences([a, b]);
		const backward = aggregateRecurrences([b, a]);
		expect(nonNull(forward[0]).assembly_significance).toBe(nonNull(forward[1]).assembly_significance);
		expect(forward.map((r) => r.signature)).toEqual(["harness_missed:pat-a", "harness_missed:pat-b"]);
		expect(backward.map((r) => r.signature)).toEqual(["harness_missed:pat-a", "harness_missed:pat-b"]);
	});

	// recurrence.ts:264-267: SAMPLE_FILES_CAP is "Max distinct files retained per row".
	it("keeps exactly ten sample files when more than ten distinct files recur", () => {
		const events = Array.from({ length: 25 }, (_, i) =>
			ev({ file: `f${i}.ts`, ts: `2026-05-01T00:00:${String(i).padStart(2, "0")}.000Z` }),
		);
		const [r] = aggregateRecurrences(events);
		expect(nonNull(r).sample_files).toHaveLength(10);
		expect(nonNull(r).distinct_files).toBe(25);
	});

	// recurrence.test.ts "preserves insertion order for equal timestamps" intent;
	// comparator returns 0 for equal times (recurrence.ts:282).
	it("keeps insertion order across many files that share one timestamp", () => {
		const names = ["a", "b", "c", "d", "e", "f"].map((n) => `${n}.ts`);
		const [r] = aggregateRecurrences(names.map((file) => ev({ file })));
		expect(nonNull(r).sample_files).toEqual(names);
	});
});

describe("proposeAction — headline names the most specific identifier", () => {
	// recurrence.ts:207, 215, 221 build headlines from check_id ?? signature.
	it("names a harness_missed pattern without its kind prefix", () => {
		const a = proposeAction(
			row({ kind: "harness_missed", signature: "harness_missed:raw-sql-concat", check_id: undefined }),
		);
		expect(a.headline).toContain("raw-sql-concat");
		expect(a.headline).not.toContain("harness_missed:");
	});

	it("names a codebase_existing cleanup by check_id when the row has one", () => {
		const a = proposeAction(
			row({ kind: "codebase_existing", signature: "codebase_existing:sig-form", check_id: "my_check" }),
		);
		expect(a.headline).toContain("my_check");
		expect(a.headline).not.toContain("sig-form");
	});

	it("names a ratchet by check_id when the row has one", () => {
		const a = proposeAction(row({ signature: "harness_caught:sig-form:claude", check_id: "my_check" }));
		expect(a.headline).toContain("my_check");
		expect(a.headline).not.toContain("sig-form");
	});
});

describe("recordHarnessCaught — persisted fields", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "recurrence-mut-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// RecurrenceEvent.phase / .severity docs, recurrence.ts:63-67.
	it("persists the originating phase and severity of the check", () => {
		recordHarnessCaught({
			check_id: "c",
			agent_source: "claude",
			session_id: "s1",
			file: "a.ts",
			phase: "pre_block",
			severity: "error",
			cwd: dir,
		});
		const [e] = loadRecurrenceEvents(dir);
		expect(nonNull(e).phase).toBe("pre_block");
		expect(nonNull(e).severity).toBe("error");
	});
});
