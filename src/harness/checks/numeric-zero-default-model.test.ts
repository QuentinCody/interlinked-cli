import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { numericMatches, numericModel } from "./numeric-zero-default-model.js";

it("binds a numeric finding to the producer and consumer in the same source snapshot", () => {
	const content = "const amount = Number(raw);\nconst total = amount || 10;";
	const file = "amount.ts";
	const gaps: string[] = [];
	const gap = (reason: string) => gaps.push(reason);
	const model = numericModel(content, file, gap);
	if (!model) throw new Error("Expected a parsed numeric model");
	const sha256 = createHash("sha256").update(content).digest("hex");
	expect(numericMatches(model, gap)).toEqual([expect.objectContaining({
		line: 2,
		sourceEvidence: [
			{ file, sha256, line: 1, role: "producer" },
			{ file, sha256, line: 2, role: "consumer" },
		],
	})]);
	expect(gaps).toEqual([]);
});
