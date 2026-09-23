import { describe, expect, it } from "vitest";
import { checkRepeatedImplementation } from "./repeated-implementation.js";

function pythonHandler(name: string, status: string): string {
    return `def ${name}(state, request):
    job_id, error = validate_lease(state, request)
    if job_id is None:
        return None, error
    new_state = copy.deepcopy(state)
    job = new_state["jobs"][job_id]
    job["status"] = "${status}"
    job["token"] = None
    job["expires"] = None
    return new_state, True
`;
}
const handlers = pythonHandler("ack", "done") + pythonHandler("retry", "pending") + pythonHandler("fail", "failed");
const jsBody = `(state) { const next = clone(state); const job = next.job; job.status = "done"; job.token = null; job.expiry = null; return next; }`;

describe("checkRepeatedImplementation", () => {
    it("MUST-FIRE: groups the three Python handlers once and exposes their differing status values", () => {
        const findings = checkRepeatedImplementation(handlers, "queue.py");
        expect(findings).toHaveLength(1);
        expect(findings[0]?.text).toContain("3 similar implementations");
        for (const status of ["done", "pending", "failed"]) expect(findings[0]?.text).toContain(status);
        expect(findings[0]?.text).toContain("keep separate if contracts differ");
    });
    it("does not change group identity when Python conditions are wrapped or lines shift", () => {
        const expanded = "\n# comment\n" + handlers.replaceAll("if job_id is None:", "if (\n        job_id is None\n    ):");
        expect(checkRepeatedImplementation(expanded, "queue.py")[0]?.fingerprint)
            .toBe(checkRepeatedImplementation(handlers, "queue.py")[0]?.fingerprint);
    });
    it("finds compact JS functions independent of physical lines", () => {
        const content = `function ack${jsBody}\nfunction retry${jsBody.replace('"done"', '"pending"')}`;
        const compact = checkRepeatedImplementation(content, "queue.ts");
        expect(compact).toHaveLength(1);
        expect(checkRepeatedImplementation(content.replaceAll(";", ";\n"), "queue.ts")[0]?.fingerprint).toBe(compact[0]?.fingerprint);
    });
    it("MUST-NOT-FIRE: does not equate different call targets or control flow", () => {
        expect(checkRepeatedImplementation(pythonHandler("ack", "done") + pythonHandler("other", "done").replace("validate_lease", "authorize_user"), "queue.py")).toEqual([]);
        expect(checkRepeatedImplementation(`function a${jsBody}\nfunction b${jsBody.replace("clone(state)", "deleteState(state)")}`, "queue.ts")).toEqual([]);
    });
    it("ignores tests, tiny wrappers, and a shared helper with small delegates", () => {
        expect(checkRepeatedImplementation(handlers, "test_queue.py")).toEqual([]);
        expect(checkRepeatedImplementation(`function a() { return work(); } function b() { return work(); }`, "q.ts")).toEqual([]);
        expect(checkRepeatedImplementation(pythonHandler("finish", "done") + "def ack(s, r):\n    return finish(s, r)\ndef retry(s, r):\n    return finish(s, r)\n", "queue.py")).toEqual([]);
    });
    it("keeps missing parser evidence distinct from a clean result", () => {
        expect(checkRepeatedImplementation("def broken(:", "q.py")[0]?.text).toContain("NOT CHECKED");
        expect(checkRepeatedImplementation("function broken( {", "q.ts")[0]?.text).toContain("NOT CHECKED");
    });
});
