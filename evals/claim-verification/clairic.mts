import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Record_ = Record<string, unknown>;
const record = (value: unknown): value is Record_ => typeof value === "object" && value !== null && !Array.isArray(value);
type Fetch_ = (url: string, init?: RequestInit) => Promise<Response>;

export function spanConventions(source: string, span: unknown, value: string): string[] {
    if (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isInteger)) return [];
    const [start, end] = span as [number, number];
    if (start < 0 || end <= start) return [];
    const matches: string[] = [];
    if (end <= source.length && source.slice(start, end) === value) matches.push("utf16");
    const points = [...source];
    if (end <= points.length && points.slice(start, end).join("") === value) matches.push("codepoints");
    const bytes = Buffer.from(source);
    if (end <= bytes.length && bytes.subarray(start, end).equals(Buffer.from(value))) matches.push("utf8-bytes");
    return matches;
}

export function assessAnswer(source: string, answer: unknown): Record_ {
    if (!record(answer) || !("value" in answer)) return { status: "malformed" };
    if (answer.value === null) return { status: "no_answer" };
    if (answer.type === "text" && typeof answer.value === "string") {
        const conventions = spanConventions(source, answer.span, answer.value);
        return { status: conventions.length ? "extracted" : "invalid_span", conventions, value: answer.value, span: answer.span };
    }
    if (answer.type === "list" && Array.isArray(answer.value) && Array.isArray(answer.spans)) {
        const spans = answer.spans;
        const items = answer.value.map((value, index) => assessAnswer(source, { type: "text", value, span: spans[index] }));
        return { status: items.every(item => item.status === "extracted") && spans.length === items.length ? "extracted" : "invalid_span", items };
    }
    if (answer.type === "number" && typeof answer.value === "number" && Number.isFinite(answer.value)) return { status: "typed_value", value: answer.value };
    return { status: "malformed" };
}

const probes = [
    { id: "unicode-negation-null", state: "🧬 Cafe\u0301\r\nReference: XY-902.\r\nDo not modify the public API.", fields: {
        reference: { type: "text", instructions: "Reference identifier" },
        constraint: { type: "text", instructions: "The complete instruction about the public API, including its negation" },
        tracking_number: { type: "text", instructions: "Shipment tracking number, if present" },
    } },
    { id: "repeated-occurrence", state: "Previous result: Tests pass.\nCurrent result: Tests pass.", fields: {
        current_result: { type: "text", instructions: "The words Tests pass. after Current result, using that occurrence" },
    } },
    { id: "clauses-number", state: "Retry at most three times after the initial attempt. Authentication failures must never be retried.", fields: {
        claims: { type: "list", items: "text", instructions: "Every complete requirement clause, retaining negations and qualifications" },
        retry_count: { type: "number", integer: true, instructions: "Maximum retries, excluding the initial attempt" },
    } },
    { id: "field-fanout", state: "Build failed. Tests passed. The retry limit is three retries.", fields: Object.fromEntries(
        Array.from({ length: 24 }, (_, i) => [`field_${i}`, { type: "text", instructions: i % 2 ? "The complete sentence about the build" : "The complete sentence about tests" }]),
    ) },
];

interface ProbeRecord extends Record_ { id: string; status: string; billingMatches?: boolean }

function assessProbeResponse(probe: typeof probes[number], request: unknown, envelope: unknown, started: number): ProbeRecord {
    const raw = record(envelope) && "result" in envelope ? envelope.result : envelope;
    if (!record(raw) || !record(raw.answers) || !record(raw.usage)) return { id: probe.id, status: "malformed" };
    const { usage, answers } = raw;
    const numericUsage = [usage.state_tokens, usage.passes, usage.schema_tokens, usage.input_tokens].every(value => typeof value === "number" && Number.isFinite(value));
    const expectedTokens = numericUsage ? Number(usage.state_tokens) * Number(usage.passes) + Number(usage.schema_tokens) : null;
    return { id: probe.id, status: raw.truncated === true ? "partial" : "completed", request, response: raw,
        latencyMs: performance.now() - started, stateTextMatches: typeof raw.state_text === "string" ? raw.state_text === probe.state : null,
        ...(expectedTokens === null ? {} : { billingMatches: expectedTokens === usage.input_tokens }),
        assessment: Object.fromEntries(Object.keys(probe.fields).map(name => [name, assessAnswer(probe.state, answers[name])])) };
}

export async function probeClairic(credentials: { token: string; account: string }, fetch_: Fetch_ = fetch): Promise<{ status: string; reason?: string; records: ProbeRecord[] }> {
    if (!credentials.token || !credentials.account) return { status: "skipped", reason: "Cloudflare API token and account ID are required", records: [] };
    const records: ProbeRecord[] = [];
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.account)}/ai/run/@cf/cloudflare/clairic`;
    for (const probe of probes) {
        const request = { model: "clairic", state: probe.state, fields: probe.fields, options: { return_state_text: true } };
        const started = performance.now();
        try {
            const response = await fetch_(endpoint, { method: "POST", headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" },
                body: JSON.stringify(request), signal: AbortSignal.timeout(20_000) });
            if (!response.ok) { records.push({ id: probe.id, status: `http_${response.status}`, latencyMs: performance.now() - started }); break; }
            const envelope: unknown = await response.json();
            records.push(assessProbeResponse(probe, request, envelope, started));
        } catch (error) {
            records.push({ id: probe.id, status: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_failed" });
            break;
        }
    }
    return { status: records.every(row => row.status === "completed" || row.status === "partial") ? "completed" : "partial", records };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const output = resolve(process.argv[2] ?? `scratch/2026-10-19-claim-verification/clairic-${Date.now()}`);
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const result = await probeClairic({ token: process.env.CLOUDFLARE_API_TOKEN ?? "", account: process.env.CLOUDFLARE_ACCOUNT_ID ?? "" });
    const report = { createdAt: new Date().toISOString(), endpointModel: "@cf/cloudflare/clairic", ...result,
        limitations: ["Synthetic probes only. Size-limit probes and production extraction accuracy are not measured.", "A completed request is not a passing semantic acceptance test."] };
    writeFileSync(resolve(output, "clairic-probes.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ output, status: result.status, reason: result.reason, requests: result.records.length }));
}
