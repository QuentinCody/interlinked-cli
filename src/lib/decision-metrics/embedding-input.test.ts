import { expect, it } from "vitest";
import { formatEmbeddingInputs, isEmbeddingGemma2 } from "./embedding-input.js";

it("uses Google's published asymmetric code-search prompts without removing full-model encoders", () => {
    // Source: https://huggingface.co/google/embeddinggemma-2#1-task-instruction-prefixes
    const result = formatEmbeddingInputs("embeddinggemma-2:740m", [
        { role: "query", text: "Where are payments retried?" },
        { role: "document", title: "payments.ts", text: "function retryPayment() {}" },
    ]);
    expect(result.texts).toEqual([
        "task: code retrieval | query: Where are payments retried?",
        "title: payments.ts | text: function retryPayment() {}",
    ]);
    expect(result.profile).toBe("embeddinggemma-2-code-retrieval-768d-v1");
    expect(isEmbeddingGemma2("embeddinggemma:300m")).toBe(false);
});

it("separates symmetric geometry from retrieval and preserves the raw comparison arm", () => {
    const inputs = [{ role: "similarity" as const, text: "function f() {}" }];
    expect(formatEmbeddingInputs("embeddinggemma-2:740m", inputs)).toEqual({
        texts: ["task: sentence similarity | query: function f() {}"],
        profile: "embeddinggemma-2-similarity-768d-v1",
    });
    expect(formatEmbeddingInputs("qwen3-embedding:4b", inputs)).toEqual({
        texts: ["function f() {}"],
        profile: "raw-v1",
    });
    expect(() =>
        formatEmbeddingInputs("embeddinggemma-2:740m", [...inputs, { role: "query", text: "f" }]),
    ).toThrow(/separate populations/);
});
