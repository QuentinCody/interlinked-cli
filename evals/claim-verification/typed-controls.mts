import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { interpretTestClaim, verifyTestClaim, type TestReceipt } from "./receipt-facts.mjs";
import { interpretOperationalClaim, verifyOperationalClaim, type OperationalReceipt } from "./operational-receipts.mjs";
import { eligibleEvidence, type Control } from "./controls.mjs";

interface Scope { receiptId: string; sourceIdentity: string; selection: string[]; cwd: string }
export interface TypedControl extends Control { interpretation?: { family: string; scope: Scope }; receipt?: TestReceipt | OperationalReceipt }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function deterministicOutcome(c: TypedControl) {
    if (!c.interpretation) return null;
    const { scope, family } = c.interpretation;
    if (!c.receipt || !eligibleEvidence(c.evidence).length) return { status: "not_assessable", reason: "no_trusted_receipt", receiptId: scope.receiptId };
    if (family === "tests") {
        const claim = interpretTestClaim(c.claim, scope);
        return claim ? verifyTestClaim(claim, c.receipt as TestReceipt) : null;
    }
    const claim = interpretOperationalClaim(c.claim, scope);
    return claim ? verifyOperationalClaim(claim, c.receipt as OperationalReceipt) : null;
}

function baseControl(seed: number, family: string): TypedControl {
    const scope = { receiptId: `run-${seed}-${family}`, sourceIdentity: hash(`revision-${seed}`), cwd: "/controlled/project", selection: [`suite-${seed}`] };
    const count = seed + 3;
    let claim = "Command completed.";
    let receipt: TestReceipt | OperationalReceipt = { id: scope.receiptId, ...scope, completion: "completed", exitCode: 0, signal: null,
        runner: "command", directInvocation: true, outputComplete: true, stdout: "", stderr: "", sourceUnchanged: true };
    if (family === "tests") {
        claim = `All ${count} executed tests passed.`;
        receipt = { id: scope.receiptId, completion: "completed", sourceIdentity: scope.sourceIdentity, selection: scope.selection,
            runner: { success: true, numTotalTests: count, numPassedTests: count, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 } };
    } else if (family === "typecheck_clean") {
        claim = "Typecheck completed cleanly."; receipt.runner = "typescript";
    } else if (family === "file_written") {
        const path = `scratch/result-${seed}.txt`; claim = `File \`${path}\` was written.`;
        receipt.fileWrite = { path, observedByCall: scope.receiptId, afterSha256: hash(`content-${seed}`), bytesWritten: 12 };
    }
    return { id: "", parentId: `${seed}:${family}`, claim, origin: "construction-certified-typed", variant: "positive", certified: true,
        expectedSupport: true, reason: "Explicit matching predicate and complete typed receipt.", evidence: [], receipt, interpretation: { family, scope } };
}

export function makeTypedControls(seed: number): TypedControl[] {
    const controls: TypedControl[] = [];
    for (const family of ["tests", "typecheck_clean", "file_written", "command_completed"]) {
        const base = baseControl(seed, family);
        for (const variant of ["positive", "removed", "altered", "summary_only", "truncated", "tail_retains_fact"]) {
            const c: TypedControl = structuredClone(base); c.variant = variant; c.id = hash(`${base.parentId}:${variant}`).slice(0, 20);
            c.expectedSupport = variant === "positive" || variant === "tail_retains_fact";
            if (variant === "altered") {
                if (family === "tests") {
                    const runner = (c.receipt as TestReceipt).runner!; runner.numPassedTests = seed + 4; runner.numTotalTests = seed + 4;
                } else if (family === "typecheck_clean") (c.receipt as OperationalReceipt).exitCode = 2;
                else if (family === "command_completed") (c.receipt as OperationalReceipt).completion = "cancelled";
                else (c.receipt as OperationalReceipt).fileWrite!.path = `scratch/other-${seed}.txt`;
                c.reason = family === "file_written" ? "The receipt proves a different file was written; the named path is unsupported, not contradicted." : "Decisive typed value opposes the predicate.";
            }
            const text = JSON.stringify(c.receipt);
            c.evidence = [{ tool: "CapturedReceipt", input: JSON.stringify(c.interpretation!.scope), result_tail: text, error: false, provenance: "structured_receipt" }];
            if (variant === "removed") { c.evidence = []; delete c.receipt; c.reason = "All evidence removed."; }
            if (variant === "summary_only") {
                c.evidence = [{ tool: "Assistant", input: "", result_tail: `I checked: ${c.claim}`, error: false, provenance: "assistant_summary" }];
                delete c.receipt; c.reason = "Only a self-authored assertion remains.";
            }
            if (variant === "truncated") {
                c.evidence[0]!.result_tail = (text + "\n" + "unrelated log entry\n".repeat(40)).slice(-400);
                delete c.receipt; c.reason = "Decisive receipt removed by an exact 400-character tail projection.";
            }
            if (variant === "tail_retains_fact") c.reason = "Truncation removes preceding noise but retains the entire decisive receipt; this remains supported.";
            controls.push(c);
        }
    }
    return controls;
}

export function makeTextControls(seed: number): TypedControl[] {
    return Array.from({ length: 4 }, (_, i) => seed + i * 7).flatMap(n => {
        const claim = `The supplied configuration document sets retry_limit to ${n}.`;
        return ["positive", "removed", "altered", "summary_only", "truncated", "tail_retains_fact"].map(variant => {
            const fact = JSON.stringify({ retry_limit: variant === "altered" ? n + 1 : n });
            return { id: hash(`config:${n}:${variant}`).slice(0, 20), parentId: `config:${n}`, claim, origin: "construction-certified-document-value",
                variant, certified: true, expectedSupport: variant === "positive" || variant === "tail_retains_fact",
                reason: "The claim concerns the supplied document's literal value, not deployed behavior. Construction fixes that value and its provenance.",
                evidence: variant === "removed" ? [] : [{ tool: variant === "summary_only" ? "Assistant" : "Read",
                    input: "configuration.json", result_tail: variant === "summary_only" ? `I verified: ${claim}` : variant === "truncated" ? "unrelated log entry\n".repeat(30).slice(-400)
                        : variant === "tail_retains_fact" ? ("irrelevant prefix\n".repeat(40) + fact).slice(-400) : fact,
                    error: false, provenance: variant === "summary_only" ? "assistant_summary" : "tool_result" }] };
        });
    });
}

function main(): void {
    const [output, seedArg = "17"] = process.argv.slice(2);
    if (!output) throw new Error("Usage: typed-controls.mts NEW_OUTPUT SEED");
    const seed = Number(seedArg); if (!Number.isSafeInteger(seed) || seed < 1) throw new Error("Invalid seed");
    const cases = [seed, seed + 11, seed + 23].flatMap(makeTypedControls);
    const text = JSON.stringify(cases, null, 2) + "\n";
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const save = (name: string, data: string) => writeFileSync(resolve(output, name), data, { flag: "wx", mode: 0o600 });
    save("cases.json", text);
    save("blind.json", JSON.stringify(cases.map(c => ({ id: c.id, claim: c.claim, scope: c.interpretation!.scope, evidence: c.evidence })), null, 2) + "\n");
    save("manifest.json", JSON.stringify({ createdAt: new Date().toISOString(), sha256: hash(text), cases: cases.length, seed,
        implementationSha256: hash(readFileSync("evals/claim-verification/typed-controls.mts", "utf8")),
        limitation: "Authored structured controls with truth from explicit construction; not a natural-corpus accuracy estimate." }, null, 2) + "\n");
    console.log(JSON.stringify({ cases: cases.length, positives: cases.filter(c => c.expectedSupport).length }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
