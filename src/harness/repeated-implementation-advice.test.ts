import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeSession } from "./__tests__/fixtures/evaluator.js";
import { appendRepeatedImplementationAdvice } from "./repeated-implementation-advice.js";
import { rescanSessionFiles } from "./stop-rescan.js";
import type { HarnessDecision } from "./types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const body = `(s) { const n = clone(s); const job = n.job; job.status = "done"; job.token = null; job.expiry = null; return n; }`;
const code = `function ack${body}\nfunction retry${body.replace('"done"', '"pending"')}`;

it("reports a landed group once, retains evidence, resurfaces after resolution, and never blocks", () => {
    const root = mkdtempSync(join(tmpdir(), "repeat-advice-")); roots.push(root);
    const path = join(root, "queue.ts"); writeFileSync(path, code);
    const session = makeSession();
    const run = () => {
        const decision: HarnessDecision = { decision: "allow" };
        const results = appendRepeatedImplementationAdvice(root, [path, path], session, decision);
        expect(decision.decision).toBe("allow");
        return { decision, results };
    };
    expect(run().decision.warnings).toHaveLength(1);
    writeFileSync(path, "\n// unrelated line shift\n" + code);
    const repeated = run();
    expect(repeated.decision.warnings).toBeUndefined();
    expect(repeated.results).toHaveLength(1);
    writeFileSync(path, `function ack${body}`); expect(run().results).toEqual([]);
    writeFileSync(path, code); expect(run().decision.warnings).toHaveLength(1);
    session.files_written.add(path);
    expect(rescanSessionFiles(session, root).some(row => row.checkId === "repeated_implementation")).toBe(true);
});

it("dry-run does not consume feedback and other sessions receive their own review", () => {
    const root = mkdtempSync(join(tmpdir(), "repeat-advice-")); roots.push(root);
    const path = join(root, "queue.ts"); writeFileSync(path, code);
    const session = makeSession();
    appendRepeatedImplementationAdvice(root, [path], session, { decision: "allow" }, true);
    for (const current of [session, makeSession()]) {
        const decision: HarnessDecision = { decision: "allow" };
        appendRepeatedImplementationAdvice(root, [path], current, decision);
        expect(decision.warnings).toHaveLength(1);
    }
});
