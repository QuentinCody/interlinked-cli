import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jevClaimsAction } from "../../commands/jev.js";
import type { JevClient } from "./client.js";

/** Pin for scratch/review-jev-receipt-shadow/REVIEW.md R5 (the writer in src/commands/jev.ts only).
 *  The shadow log is observation only: these cases assert what the writer persists, never a verdict change. */

const TOKEN = "sk-live-ABCDEF1234567890";
const UNLINKED = `The rotated token is ${TOKEN} and the deploy worked fine.`;
const LINKED_GRAMMAR = "All 3 executed tests passed.";

/** Jev answers nothing, so scoreClaims takes the observe-only path; the writer runs either way. */
const stub = {
    ask: async () => null,
    spend: () => ({ calls: 1, failures: 0, usd: 0, input_tokens: 0, output_tokens: 0 }),
} as unknown as JevClient;

let cwd = "";
beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "jev-shadow-redact-"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
});

function testsLink(claim: string) {
    return { claim, family: "tests",
        scope: { receiptId: "r1", sourceIdentity: "rev1", selection: ["suite"], cwd },
        receipt: { id: "r1", sourceIdentity: "rev1", selection: ["suite"], completion: "completed",
            runner: { success: true, numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 } } };
}

async function runShadow(finalMessage: string, links: unknown[]) {
    const finalFile = join(cwd, "final.txt"), transcript = join(cwd, "transcript.jsonl"), linksFile = join(cwd, "links.json");
    writeFileSync(finalFile, finalMessage);
    writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npx vitest run x" } } ] } }) + "\n"
        + JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "3 passed" }] } }) + "\n");
    writeFileSync(linksFile, JSON.stringify(links));
    const exit = await jevClaimsAction(finalFile, transcript, { client: stub, cwd, json: true, receiptShadow: linksFile, shadowClient: null });
    const text = readFileSync(join(cwd, ".interlinked", "claim-receipt-shadow.jsonl"), "utf8");
    const rows = text.trimEnd().split("\n").map(line => JSON.parse(line) as { claim: string; status: string; reason: string });
    return { exit, text, rows };
}

describe("jev command shadow-log redaction review regressions", () => {
    it("R: trust-boundary-unredacted-final-message-in-shadow-log — unlinked sentences are digested and linked ones scrubbed", async () => {
        // P: the review counterexample — one linked grammar line, one unlinked sentence carrying a secret.
        const a = await runShadow(`${LINKED_GRAMMAR}\n${UNLINKED}`, [testsLink(LINKED_GRAMMAR)]);
        expect(a.exit).toBe(0);
        expect(a.text).not.toContain(TOKEN);                       // (a) the raw token never reaches the file
        expect(a.text).not.toContain("rotated token");             // (b) the unlinked sentence's text is absent
        const unlinked = a.rows.find(r => r.reason === "missing_link");
        expect(unlinked).toBeDefined();
        expect(unlinked!.claim).toMatch(/^sha256:[0-9a-f]{16}$/);  // the unlinked count survives as a stable digest
        expect(a.rows).toContainEqual(expect.objectContaining({    // (c) the linked grammar row is intact and supported
            claim: LINKED_GRAMMAR, status: "supported", reason: "matching_completed_runner_result" }));
        expect(a.rows).toHaveLength(2);

        // P: a LINKED sentence that carries a token-shaped literal is written in its scrubbed form, verdict unchanged.
        rmSync(join(cwd, ".interlinked"), { recursive: true, force: true });
        const b = await runShadow(UNLINKED, [testsLink(UNLINKED)]);
        expect(b.exit).toBe(0);
        expect(b.text).not.toContain(TOKEN);
        expect(b.rows).toHaveLength(1);
        expect(b.rows[0]!.claim).toContain("[REDACTED:");
        expect(b.rows[0]!.claim).toBe(`The rotated token is [REDACTED:openai_key] and the deploy worked fine.`);
        expect(b.rows[0]!.reason).toBe("unsupported_claim_grammar"); // the verdict fields are copied, not supplied

        // N: a linked claim with nothing to scrub is written verbatim — the scrub is not a rewrite.
        rmSync(join(cwd, ".interlinked"), { recursive: true, force: true });
        const c = await runShadow(LINKED_GRAMMAR, [testsLink(LINKED_GRAMMAR)]);
        expect(c.rows).toEqual([expect.objectContaining({ claim: LINKED_GRAMMAR, status: "supported" })]);
    });
});
