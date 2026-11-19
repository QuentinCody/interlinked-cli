import { describe, expect, it } from "vitest";
import type { OutcomeEvent } from "./outcomes.js";
import { retrievalCostByFile } from "./retrieval-cost.js";

describe("retrievalCostByFile — mutation-directed", () => {
	// test-contract: invariant — a NotebookRead is exploration, never an edit, so it is charged to the next edit
	it("counts a NotebookRead as a read before the edit and never as an edited file", () => {
		const events: OutcomeEvent[] = [
			{ tool: "NotebookRead", decision: "allow", outcome: "success", file: "n.ipynb" },
			{ tool: "Edit", decision: "allow", outcome: "success", file: "c.ts", sha: "c-1" },
		];
		const cost = retrievalCostByFile(events);
		expect([...cost.keys()]).toEqual(["c.ts"]);
		expect(cost.get("c.ts")?.readsBeforeEdit).toBe(1);
	});
});
