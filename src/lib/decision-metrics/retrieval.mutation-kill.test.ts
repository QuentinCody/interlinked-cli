import { expect, it } from "vitest";
import { retrieve } from "./retrieval.js";
import type { HistoryDocument } from "./retrieval.js";

// test-contract: boundary — a document stamped at the query instant is not eligible
it("excludes a document with the same timestamp as the query", () => {
	const docs: HistoryDocument[] = [
		{ id: "same", text: "retry backoff", timestamp: "2026-05-01", fixCommit: "a", sourceHash: "a" },
	];
	const result = retrieve({ text: "retry backoff", timestamp: "2026-05-01" }, docs, {
		method: "lexical",
		top: 3,
	});
	expect(result.eligible).toBe(0);
	expect(result.results).toEqual([]);
	expect(result.excludedFuture).toBe(1);
});
