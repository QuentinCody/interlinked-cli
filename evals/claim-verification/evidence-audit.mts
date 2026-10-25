import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Object_ = Record<string, unknown>;
const object = (value: unknown): Object_ => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Object_ : {};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
interface Call { id: string; inputChars: number; resultChars: number | null; line: number; resultLine: number | null }
interface TurnAudit {
    calls: number; completedResults: number; missingResults: number; callsOmittedBy25Limit: number;
    inputCharsOmittedBy300Limit: number; resultCharsOmittedBy400Limit: number;
    finalTextHash: string; callReferences: Call[];
}

function summarizeTurn(calls: Map<string, Call>, finalText: string): TurnAudit {
    const all = [...calls.values()];
    const kept = all.slice(-25);
    return { calls: all.length, completedResults: all.filter(call => call.resultChars !== null).length,
        missingResults: all.filter(call => call.resultChars === null).length, callsOmittedBy25Limit: Math.max(0, all.length - 25),
        inputCharsOmittedBy300Limit: kept.reduce((sum, call) => sum + Math.max(0, call.inputChars - 300), 0),
        resultCharsOmittedBy400Limit: kept.reduce((sum, call) => sum + Math.max(0, (call.resultChars ?? 0) - 400), 0),
        finalTextHash: hash(finalText), callReferences: all };
}

function recordCalls(blocks: Object_[], calls: Map<string, Call>, line: number): void {
    for (const block of blocks) {
        if (block.type !== "tool_use" || typeof block.id !== "string") continue;
        const input = object(block.input);
        const direct = input[block.name === "Bash" ? "command" : "file_path"];
        const rendered = typeof direct === "string" ? direct : JSON.stringify(input);
        calls.set(block.id, { id: block.id, inputChars: rendered.length, resultChars: null, line, resultLine: null });
    }
}

function recordResults(blocks: Object_[], calls: Map<string, Call>, line: number): void {
    for (const block of blocks) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        const text = typeof block.content === "string" ? block.content : Array.isArray(block.content)
            ? block.content.map(item => object(item).text).filter(value => typeof value === "string").join("\n") : "";
        call.resultChars = text.length;
        call.resultLine = line;
    }
}

/** Match the historical builder's human-prompt turn boundaries; never interpret absence as failure. */
export function auditTranscript(source: string): Map<number, TurnAudit> {
    const turns = new Map<number, TurnAudit>();
    let turn = 0;
    let calls = new Map<string, Call>();
    let finalText = "";
    for (const [index, line] of source.split("\n").entries()) {
        if (!line.trim()) continue;
        const row = object(JSON.parse(line));
        const message = object(row.message);
        const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
        if (row.type === "user" && message.role === "user" && (typeof message.content === "string"
            || (blocks.some(block => block.type === "text") && !blocks.some(block => block.type === "tool_result")))) {
            turns.set(turn, summarizeTurn(calls, finalText)); turn++; calls = new Map(); finalText = ""; continue;
        }
        if (row.type === "assistant") {
            const text = blocks.filter(block => block.type === "text" && typeof block.text === "string");
            if (text.length) finalText = text.map(block => block.text).join("\n");
            recordCalls(blocks, calls, index + 1);
        }
        if (row.type !== "user") continue;
        recordResults(blocks, calls, index + 1);
    }
    turns.set(turn, summarizeTurn(calls, finalText));
    return turns;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const output = resolve(process.argv[2] ?? `scratch/2026-10-19-claim-verification/evidence-${Date.now()}`);
    const dataset = "scratch/2026-09-16-jev-checks/a1-dataset.jsonl";
    const datasetText = readFileSync(dataset, "utf8");
    const rows = datasetText.trim().split("\n").map(line => object(JSON.parse(line)));
    const audits: Object_[] = [];
    for (const session of new Set(rows.map(row => String(row.session)))) {
        const path = join(homedir(), ".claude", "projects", "-Users-quentincody-interlinked-cli", `${session}.jsonl`);
        const selected = rows.filter(row => row.session === session);
        if (!existsSync(path)) { audits.push({ session, status: "not_found_at_original_path", selectedTurns: selected.length }); continue; }
        const source = readFileSync(path, "utf8");
        try {
            const turns = auditTranscript(source);
            audits.push({ session, status: "read", path, sourceHash: hash(source), selectedTurns: selected.length,
                turns: selected.map(row => { const audit = turns.get(Number(String(row.id).split(":").at(-1))); return {
                    id: row.id, sourceMatches: audit?.finalTextHash === hash(String(row.final_text)), audit: audit ?? null,
                }; }) });
        } catch {
            audits.push({ session, status: "parse_failed", path, sourceHash: hash(source), selectedTurns: selected.length });
        }
    }
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(join(output, "evidence-audit.json"), JSON.stringify({ datasetHash: hash(datasetText), audits,
        limitations: ["Only original native transcript paths were checked; not found does not mean deleted or never captured.",
            "Native tool content may already be provider-truncated. Counts describe the additional historical evaluator projection.",
            "No raw transcript content is copied or sent to a model."] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ output, sessions: audits.map(({ session, status, selectedTurns }) => ({ session, status, selectedTurns })) }, null, 2));
}
