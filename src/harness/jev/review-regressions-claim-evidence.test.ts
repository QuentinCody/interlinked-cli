import { describe, expect, it } from "vitest";
import { scoreClaims, splitClaims } from "./claim-evidence.js";
import type { JevClient } from "./client.js";
import type { ReceiptShadowRow } from "./receipt-shadow.js";
import type { JevEntry, JevQuestion, JevResponse } from "./types.js";

/** Pins for scratch/review-jev-receipt-shadow/REVIEW.md R1 and R4 (claim-evidence.ts only). */
const SHA = "a".repeat(64);
const EVIDENCE = [{ tool: "Bash", input: "npx vitest run", result_tail: "3 passed", error: false }];

/** Jev double: every claim is checkable; `evidenced` answers per claim text (default 0.0 = "unsupported"). */
function fakeClient(evidenced: Record<string, number> = {}) {
	const asked: JevEntry[] = [];
	const client = {
		async ask(state: JevEntry, questions: Record<string, JevQuestion>): Promise<JevResponse | null> {
			asked.push(state);
			const claims = (state as { claims: string[] }).claims; // SAFETY: scoreClaims builds exactly this shape
			const answers: JevResponse["answers"] = {};
			for (const id of Object.keys(questions)) {
				const i = Number(id.slice(1));
				answers[id] = { type: "noul", noul: id.startsWith("k") ? 0.9 : (evidenced[claims[i] ?? ""] ?? 0.0) };
			}
			return { model: "fake", answers, usage: { input_tokens: 1, output_tokens: 0 } };
		},
	} as unknown as JevClient;
	return { client, asked };
}

function testsLink(claim: string, passed = 3) {
	return { claim, family: "tests", scope: { receiptId: "r1", sourceIdentity: "rev1", selection: ["suite"], cwd: "/p" },
		receipt: { id: "r1", sourceIdentity: "rev1", selection: ["suite"], completion: "completed",
			runner: { success: passed === 3, numTotalTests: 3, numPassedTests: passed, numFailedTests: 3 - passed, numPendingTests: 0, numTodoTests: 0 } } };
}
function opLink(claim: string, extra: Record<string, unknown> = {}) {
	return { claim, family: "operational", scope: { receiptId: "r2", sourceIdentity: "rev1", selection: ["suite"], cwd: "/p" },
		receipt: { id: "r2", cwd: "/p", sourceIdentity: "rev1", selection: ["suite"], completion: "completed", runner: "typescript",
			directInvocation: true, outputComplete: true, sourceUnchanged: true, exitCode: 0, signal: null, ...extra } };
}
function fileLink(claim: string, path: string) {
	return opLink(claim, { fileWrite: { path, observedByCall: "r2", afterSha256: SHA, bytesWritten: 10 } });
}

async function observe(message: string, links: unknown[], evidenced: Record<string, number> = {}) {
	const rows: ReceiptShadowRow[] = [];
	const { client, asked } = fakeClient(evidenced);
	const shadow = fakeClient(evidenced);
	const findings = await scoreClaims(client, message, EVIDENCE, { enabled: true, links, write: (r) => rows.push(r), client: shadow.client });
	return { rows, asked, shadowAsked: shadow.asked, findings };
}

describe("claim-evidence review regressions", () => {
	it("R: trust-boundary-disagrees-channel-structurally-dead — every grammar line is scored, so `disagrees` is computed", async () => {
		// P: Jev says unsupported (e=0.0) against a supported link, for each of the four grammars.
		const grammars: Array<[string, unknown]> = [
			["All 3 executed tests passed.", testsLink("All 3 executed tests passed.")],
			["Command completed.", opLink("Command completed.")],
			["Typecheck completed cleanly.", opLink("Typecheck completed cleanly.")],
			["File `src/x.ts` was written.", fileLink("File `src/x.ts` was written.", "src/x.ts")],
		];
		for (const [claim, link] of grammars) {
			expect(splitClaims(claim)).toEqual([]);
			const { rows, findings } = await observe(claim, [link]);
			expect(findings).toEqual([]);
			expect(rows).toEqual([expect.objectContaining({ claim, status: "supported", jevSupported: false, disagrees: true })]);
		}
		// P (inverse): Jev says supported (e=0.9) against a contradicted link.
		const contradicted = await observe("All 3 executed tests passed.", [testsLink("All 3 executed tests passed.", 2)], { "All 3 executed tests passed.": 0.9 });
		expect(contradicted.rows).toEqual([expect.objectContaining({ status: "contradicted", jevSupported: true, disagrees: true })]);
		// N: an agreeing pair.
		const agree = await observe("Command completed.", [opLink("Command completed.")], { "Command completed.": 0.9 });
		expect(agree.rows).toEqual([expect.objectContaining({ status: "supported", jevSupported: true, disagrees: false })]);
		// N: the public judgment path is untouched — a grammar-only message sends the judgment client nothing;
		// the grammar line goes to the shadow's own client only.
		expect(agree.asked).toEqual([]);
		expect(agree.shadowAsked.map((s) => (s as { claims: string[] }).claims)).toEqual([["Command completed."]]);
	});

	it("R: correctness-shadow-jev-score-key-mismatch — one row per sentence, keyed on the raw (backticked) line", async () => {
		const raw = "File `a b c.ts` was written.";
		const stripped = "File a b c.ts was written.";
		const message = `${raw}\nThe daemon now serves the rebuilt bundle on the socket.`;
		// The stripped twin is long enough for the public path; it must still reach the public Jev request unchanged.
		expect(splitClaims(message)).toEqual([stripped, "The daemon now serves the rebuilt bundle on the socket."]);
		const { rows, asked, findings } = await observe(message, [fileLink(raw, "a b c.ts")]);
		expect((asked[0] as { claims: string[] }).claims).toEqual(splitClaims(message));
		expect(findings.map((f) => f.claim)).toEqual(splitClaims(message));
		// P: exactly one row for that sentence, keyed on the backticked text, with the score and the verdict on the same row.
		const fileRows = rows.filter((r) => r.claim.startsWith("File "));
		expect(fileRows).toEqual([expect.objectContaining({ claim: raw, status: "supported", reason: "matching_observed_write", jevSupported: false, disagrees: true })]);
		expect(rows.map((r) => r.claim)).not.toContain(stripped);
		// N: the unrelated long sentence keeps its own row.
		expect(rows).toContainEqual(expect.objectContaining({ claim: "The daemon now serves the rebuilt bundle on the socket.", reason: "missing_link", jevSupported: false, disagrees: null }));
	});
});
