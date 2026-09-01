// interlinked-tdd: exempt
// ===========================================
// Policy Classifier — response/output parsers
// ===========================================
// Pure parsers extracted from policy-classifier.ts. Each takes model/CLI
// output and returns a PolicyClassification. No module-private state — they
// depend only on the JsonObject/PolicyClassification types and each other.

import { isJsonObject } from "../lib/json-types.js";
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import type { PolicyClassification } from "./types.js";

/**
 * Parse claude -p --output-format json output.
 * With --json-schema, classification is in structured_output.
 * Without, it's in result (markdown-fenced JSON).
 */
export function parseClaudeCodeOutput(output: string): PolicyClassification {
	try {
		const wrapper: unknown = JSON.parse(output);
		if (!isJsonObject(wrapper)) return parseClassificationJson(output);
		// --json-schema puts parsed result directly in structured_output
		if (isJsonObject(wrapper.structured_output)) {
			const so = wrapper.structured_output;
			return {
				label: so.compliant === false ? "deny" : "allow",
				confidence: Math.max(0, Math.min(1, Number(so.confidence) || 0)),
				reasoning: String(so.reasoning || "No reasoning provided"),
				policy_id: typeof so.policy_id === "string" && so.policy_id ? so.policy_id : undefined,
			};
		}
		// Fallback: result field contains text (possibly markdown-fenced)
		return parseClassificationJson(String(wrapper.result || ""));
	} catch {
		return parseClassificationJson(output);
	}
}

/**
 * Parse an OpenAI-compatible chat completions response.
 */
export function parseOpenAIResponse(data: JsonObject): PolicyClassification {
	try {
		const choices = data.choices as Array<JsonObject> | undefined;
		if (!choices || choices.length === 0) {
			return { label: "allow", confidence: 0, reasoning: "No choices in response" };
		}
		const message = nonNull(choices[0]).message as JsonObject | undefined;
		return parseClassificationJson(String(message?.content || ""));
	} catch {
		return { label: "allow", confidence: 0, reasoning: "Failed to parse OpenAI response" };
	}
}

/**
 * Parse an Anthropic Messages API response.
 */
export function parseAnthropicResponse(data: JsonObject): PolicyClassification {
	try {
		const content = data.content as Array<JsonObject> | undefined;
		if (!content || content.length === 0) {
			return { label: "allow", confidence: 0, reasoning: "No content in response" };
		}
		return parseClassificationJson(String(nonNull(content[0]).text || ""));
	} catch {
		return { label: "allow", confidence: 0, reasoning: "Failed to parse Anthropic response" };
	}
}

/**
 * Parse the JSON classification payload from model output text.
 */
function parseClassificationJson(text: string): PolicyClassification {
	try {
		// Strip markdown code fences (claude -p wraps output in ```json ... ```)
		let cleaned = text.trim();
		const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
		if (fenceMatch) cleaned = nonNull(fenceMatch[1]).trim();
		const parsed: unknown = JSON.parse(cleaned);
		if (!isJsonObject(parsed)) {
			return { label: "allow", confidence: 0, reasoning: "Failed to parse classifier JSON" };
		}
		const compliant = parsed.compliant;
		const confidence = Number(parsed.confidence) || 0;
		const reasoning = String(parsed.reasoning || "No reasoning provided");
		const policyId = typeof parsed.policy_id === "string" ? parsed.policy_id : undefined;

		return {
			label: compliant === false ? "deny" : "allow",
			confidence: Math.max(0, Math.min(1, confidence)),
			reasoning,
			policy_id: policyId || undefined,
		};
	} catch {
		return { label: "allow", confidence: 0, reasoning: "Failed to parse classifier JSON" };
	}
}
