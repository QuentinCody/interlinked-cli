import { describe, expect, it } from "vitest";
import { recordReads } from "./read-set.js";

interface Ev {
	tool: string;
	input: { command?: string; file_path?: string };
}
interface St {
	verifyRunCount: number;
	fileReadSteps: Map<string, number>;
}

function fixture(): { state: St; event: Ev } {
	return {
		state: { verifyRunCount: 2, fileReadSteps: new Map([["/a.ts", 1]]) },
		event: { tool: "Bash", input: { command: "npm test", file_path: "/a.ts" } },
	};
}

describe("recordReads — positive (must record)", () => {
	it("P1: records nested event fields in first-read order", () => {
		const { state, event } = fixture();
		const r = recordReads(state, event);
		void r.event.input.command;
		void r.event.tool;
		expect(r.reads()).toEqual(["event.input", "event.input.command", "event.tool"]);
	});

	it("P2: records state fields and returns Map values unwrapped", () => {
		const { state, event } = fixture();
		const r = recordReads(state, event);
		expect(r.state.verifyRunCount).toBe(2);
		expect(r.state.fileReadSteps.get("/a.ts")).toBe(1);
		expect(r.reads()).toEqual(["state.verifyRunCount", "state.fileReadSteps"]);
	});

	it("P3: a repeated read is recorded once", () => {
		const { state, event } = fixture();
		const r = recordReads(state, event);
		void r.event.tool;
		void r.event.tool;
		expect(r.reads()).toEqual(["event.tool"]);
	});
});

describe("recordReads — negative (must not)", () => {
	it("N1: reads nothing until a field is touched", () => {
		const { state, event } = fixture();
		expect(recordReads(state, event).reads()).toEqual([]);
	});

	it("N2: refuses writes through the recorder and leaves the original intact", () => {
		const { state, event } = fixture();
		const r = recordReads(state, event);
		expect(() => {
			// SAFETY: the test writes through the recorder on purpose; `tool` exists on Ev.
			(r.event as { tool: string }).tool = "Edit";
		}).toThrow();
		expect(event.tool).toBe("Bash");
	});

	it("N3: does not record symbol-keyed access", () => {
		const { state, event } = fixture();
		const r = recordReads(state, event);
		// SAFETY: symbol access is the behavior under test; Ev has no symbol keys, so the read is `undefined`.
		void (r.event as unknown as Record<symbol, unknown>)[Symbol.toPrimitive];
		expect(r.reads()).toEqual([]);
	});
});
