import { describe, expect, it } from "vitest";
import { isEmbeddingGemma2 } from "./embedding-input.js";

describe("embedding-input mutation kills", () => {
	// test-contract: boundary — an "@" revision suffix after embeddinggemma-2 still names the model
	it("accepts an @-tagged embeddinggemma-2 model name", () => {
		expect(isEmbeddingGemma2("embeddinggemma-2@rev1")).toBe(true);
		expect(isEmbeddingGemma2("embeddinggemma-2x")).toBe(false);
	});
});
