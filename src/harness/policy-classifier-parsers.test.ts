import { describe, expect, it } from "vitest";
import { parseAnthropicResponse, parseClaudeCodeOutput, parseOpenAIResponse } from "./policy-classifier-parsers.js";

describe("classifier response boundaries", () => {
    it("withholds confidence when a provider returns a null payload", () => {
        expect(parseClaudeCodeOutput("null")).toEqual({ label: "allow", confidence: 0, reasoning: "Failed to parse classifier JSON" });
        expect(parseOpenAIResponse(null)).toEqual({ label: "allow", confidence: 0, reasoning: "No choices in response" });
        expect(parseAnthropicResponse(null)).toEqual({ label: "allow", confidence: 0, reasoning: "No content in response" });
    });

    it("does not accept an OpenAI choice whose message is missing", () => {
        expect(parseOpenAIResponse({ choices: [{ message: null }] })).toEqual({
            label: "allow", confidence: 0, reasoning: "Failed to parse classifier JSON",
        });
    });
});
