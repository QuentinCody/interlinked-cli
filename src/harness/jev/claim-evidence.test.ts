import { describe, expect, it, vi } from "vitest";
import {
	CLAIM_CHECKABLE_MIN,
	CLAIM_EVIDENCED_MIN,
	evidenceFromTranscript,
	formatClaimEvidenceWarning,
	scoreClaims,
	splitClaims,
} from "./claim-evidence.js";
import { JevClient } from "./client.js";

const FINAL = `Done. The client is written to src/harness/jev/client.ts and all 14 tests pass.

\`\`\`
ignored code block
\`\`\`

Next: run the full suite and paste the first failing line.`;

function transcript(lines: unknown[]): string {
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const TRANSCRIPT = transcript([
	{ type: "user", message: { role: "user", content: "earlier prompt" } },
	{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "ls" } }] } },
	{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "old.txt" }] } },
	{ type: "user", message: { role: "user", content: "the last human prompt" } },
	{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "src/x.ts", content: "..." } }] } },
	{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "File created" }] } },
	{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npx vitest run" } }] } },
	{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "Tests 14 passed" }], is_error: false }] } },
	{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: FINAL }] } },
]);

function clientWith(checkable: number, evidenced: number): JevClient {
	const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> }; // SAFETY: the client serializes exactly this shape
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: id.startsWith("k") ? checkable : evidenced };
		return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
	});
	return new JevClient({ apiKey: "k", fetchImpl });
}

describe("splitClaims", () => {
	it("P1: splits sentences, drops code blocks and short fragments", () => {
		// "Done." is its own sentence and falls under the 6-word floor.
		expect(splitClaims(FINAL)).toEqual([
			"The client is written to src/harness/jev/client.ts and all 14 tests pass.",
			"Next: run the full suite and paste the first failing line.",
		]);
	});
	it("N1: empty text yields nothing", () => {
		expect(splitClaims("")).toEqual([]);
	});
});

describe("evidenceFromTranscript", () => {
	it("P1: returns only the tool calls after the last human prompt, with result tails", () => {
		const ev = evidenceFromTranscript(TRANSCRIPT);
		expect(ev.map((e) => e.tool)).toEqual(["Write", "Bash"]);
		expect(ev[0]?.input).toBe("src/x.ts");
		expect(ev[1]).toMatchObject({ input: "npx vitest run", result_tail: "Tests 14 passed", error: false });
	});
	it("N1: a transcript with no tool calls after the last prompt yields nothing", () => {
		expect(evidenceFromTranscript(transcript([{ type: "user", message: { role: "user", content: "hi" } }]))).toEqual([]);
	});
});

describe("scoreClaims — positive (must fire)", () => {
	it("P1: a checkable claim with weak evidence is reported as assumed", async () => {
		const findings = await scoreClaims(clientWith(0.9, CLAIM_EVIDENCED_MIN - 0.1), FINAL, evidenceFromTranscript(TRANSCRIPT));
		expect(findings).toHaveLength(2);
		expect(findings[0]?.claim).toContain("14 tests pass");
	});
});

describe("scoreClaims — negative (must not fire)", () => {
	it("N1: a checkable claim the evidence supports is not reported", async () => {
		expect(await scoreClaims(clientWith(0.9, 0.9), FINAL, evidenceFromTranscript(TRANSCRIPT))).toEqual([]);
	});
	it("N2: a sentence that is not a checkable claim is not reported however weak its evidence", async () => {
		expect(await scoreClaims(clientWith(CLAIM_CHECKABLE_MIN - 0.1, 0.0), FINAL, evidenceFromTranscript(TRANSCRIPT))).toEqual([]);
	});
	it("N3: no evidence at all (read-only turn) yields no findings — nothing to judge against", async () => {
		expect(await scoreClaims(clientWith(0.9, 0.0), FINAL, [])).toEqual([]);
	});
	it("N4: a failing client yields no findings", async () => {
		const client = new JevClient({ apiKey: "k", fetchImpl: async () => new Response("x", { status: 500 }) });
		expect(await scoreClaims(client, FINAL, evidenceFromTranscript(TRANSCRIPT))).toEqual([]);
	});
});

describe("formatClaimEvidenceWarning", () => {
	it("P1: one warning listing the assumed claims with their evidence probability", () => {
		const w = formatClaimEvidenceWarning([{ claim: "all 14 tests pass.", checkable: 0.9, evidenced: 0.1 }]);
		expect(w).toContain("[interlinked:jev-claims]");
		expect(w).toContain("all 14 tests pass.");
		expect(w).toContain("0.10");
	});
	it("N1: no findings → null", () => {
		expect(formatClaimEvidenceWarning([])).toBeNull();
	});
});
