// Mutation-directed companion for harvest.ts (kill-proof census 2026-11-05).
// Fault: `if (got === null) continue;` becomes `break` in harvestPending's
// merge loop, so once one shard is gone every LATER shard's survivors are
// dropped and `harvested` under-counts — a dead first shard silences real
// findings from the rest.
import { describe, expect, it } from "vitest";
import { harvestPending } from "./harvest.js";
import type { PendingRun } from "./pending-runs.js";

const NOW = 1_800_000_000_000;

function pending(over: Partial<PendingRun> = {}): PendingRun {
	return { file: "src/a.ts", overlayHash: "h", jobId: "job-1", runnerUrl: "http://runner/", startedAt: NOW, ...over };
}

const REPORT = {
	files: {
		"src/a.ts": {
			source: "function f(x){ return x > 0; }",
			mutants: [
				{
					mutatorName: "EqualityOperator",
					replacement: ">=",
					status: "Survived",
					location: { start: { line: 1, column: 25 }, end: { line: 1, column: 26 } },
				},
			],
		},
	},
};

describe("harvestPending — a gone shard does not silence the shards after it", () => {
	// test-contract: invariant - the merge is per shard: an unreachable FIRST shard contributes nothing, and the ready shard behind it is still harvested with its survivors
	it("harvests a ready shard ordered after an unreachable one", async () => {
		const fetchFor = async (url: string) => {
			if (url.includes("gone")) throw new Error("connection refused");
			return { ok: true, status: 200, json: async () => REPORT };
		};
		const out = await harvestPending(
			[pending({ jobId: "gone", runnerUrl: "http://gone/" }), pending({ jobId: "ready", runnerUrl: "http://ready/" })],
			fetchFor,
		);
		expect(out.harvested).toBe(1);
		expect(out.survivors).toHaveLength(1);
	});

	// test-contract: invariant - a non-404 server refusal on the first shard is also "gone" and still leaves the later shard's report counted
	it("counts the later shard when the first answered with a non-404 error", async () => {
		const fetchFor = async (url: string) => {
			if (url.includes("broken")) return { ok: false, status: 500, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => REPORT };
		};
		const out = await harvestPending(
			[pending({ jobId: "broken", runnerUrl: "http://broken/" }), pending({ jobId: "ready", runnerUrl: "http://ready/" })],
			fetchFor,
		);
		expect(out.harvested).toBe(1);
		expect(out.survivors.map((s) => s.replacement)).toEqual([">="]);
	});
});
