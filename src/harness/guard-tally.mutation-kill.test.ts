import { beforeEach, describe, expect, it } from "vitest";
import { guardTallySnapshot, recordGuardDecision, resetGuardTally } from "./guard-tally.js";

beforeEach(() => {
	resetGuardTally();
});

describe("recordGuardDecision — mutation-directed (block is terminal)", () => {
	// test-contract: invariant — a refused call is counted as a block only; warnings that ride along on a block must not ALSO inflate the warned count
	it("does not count warnings attached to a block", () => {
		recordGuardDecision({ decision: "block", rule_id: "builtin-rm-rf-root", warnings: ["w1", "w2"] });
		expect(guardTallySnapshot()).toEqual({ blocked: 1, warned: 0, asked: 0, lastBlockRule: "builtin-rm-rf-root" });
	});
});
