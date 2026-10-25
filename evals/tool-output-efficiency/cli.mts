import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ReceiptStore } from "./receipts.mjs";
import { selectOutput, type Scorer } from "./selection.mjs";
import { codeScores, type Category } from "./adapters.mjs";
import { decisionScores } from "./decision.mjs";
import { JevClient } from "../../src/harness/jev/client.js";
import { resolveApiKey } from "../../src/harness/policy-classifier.js";
const flags = {
    store: { type: "string" }, input: { type: "string" }, source: { type: "string" }, version: { type: "string" },
    "call-id": { type: "string" }, question: { type: "string" }, category: { type: "string", default: "mixed" },
    "budget-chars": { type: "string", default: "4000" }, "min-chars": { type: "string", default: "6000" },
    mode: { type: "string", default: "code" }, baseline: { type: "string" }, full: { type: "boolean" },
    complete: { type: "boolean" }, id: { type: "string" }, start: { type: "string" }, end: { type: "string" },
} as const;

function createScoringSession(mode: string, category: Category) {
    let client: JevClient | undefined;
    const scorer: Scorer = async (blocks, question) => {
        if (mode === "code") return codeScores(category, blocks, question);
        const key = resolveApiKey("TYPESAFE_API_KEY");
        if (!key) throw new Error("Missing TYPESAFE_API_KEY");
        client = new JevClient({ apiKey: key, config: { model: "jev-1.13.0", timeout_ms: 15_000, max_spend_usd: 0.25 } });
        const scores: Record<string, number> = {};
        for (let start = 0; start < blocks.length; start += 16) {
            Object.assign(scores, await decisionScores(blocks.slice(start, start + 16), question, (state, questions) => client!.ask(state, questions)));
        }
        return scores;
    };
    return { scorer, spend: () => client?.spend() ?? null };
}

function expandReceipt(store: ReceiptStore, directory: string, id: string | undefined,
    start: string | undefined, end: string | undefined): void {
    if (!id) throw new Error("--id is required");
    process.stdout.write(store.expand(id, start === undefined ? 0 : Number(start),
        end === undefined ? undefined : Number(end)));
    appendFileSync(join(directory, "events.jsonl"), JSON.stringify({ kind: "expand", id, start, end, at: new Date().toISOString() }) + "\n");
}

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({ options: flags, allowPositionals: true });
    if (!values.store) throw new Error("--store is required");
    const store = new ReceiptStore(values.store);
    if (positionals[0] === "expand") {
        expandReceipt(store, values.store, values.id, values.start, values.end);
        return;
    }
    if (positionals[0] !== "capture" || !values.input || !values.source || !values.version || !values["call-id"]) {
        throw new Error("capture requires --input, --source, --version and --call-id");
    }
    const categories: Category[] = ["mixed", "file_reads", "search", "test_build", "structured_data", "history", "diffs_status"];
    if (!categories.includes(values.category as Category)) throw new Error("Unknown category");
    if (!["code", "jev"].includes(values.mode)) throw new Error("Unknown mode");
    const receipt = store.put({ text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(values.input)),
        source: values.source, version: values.version, callId: values["call-id"],
        ...(values.complete === undefined ? {} : { capturedComplete: values.complete }) });
    const scoring = createScoringSession(values.mode, values.category as Category);
    const start = performance.now();
    const view = await selectOutput(receipt, { question: values.question ?? "", full: values.full ?? false,
        budgetChars: Number(values["budget-chars"]), minChars: Number(values["min-chars"]),
        ...(values.baseline ? { baseline: readFileSync(values.baseline, "utf8") } : {}) }, scoring.scorer);
    appendFileSync(join(values.store, "events.jsonl"), JSON.stringify({ kind: "capture", id: receipt.id, mode: view.mode,
        category: values.category, latencyMs: performance.now() - start, spend: scoring.spend(),
        omittedChars: view.omittedChars ?? null, at: new Date().toISOString() }) + "\n");
    process.stdout.write(JSON.stringify(view) + "\n");
}
main().catch(error => { process.stderr.write(String(error instanceof Error ? error.message : error) + "\n"); process.exitCode = 1; });
