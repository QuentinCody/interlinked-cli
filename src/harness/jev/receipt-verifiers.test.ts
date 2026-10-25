import { describe, expect, it } from "vitest";
import { interpretTestClaim, verifyTestClaim, interpretOperationalClaim, verifyOperationalClaim } from "./receipt-verifiers.js";

describe("explicit scoped receipt predicates", () => {
    const scope = { receiptId: "r1", sourceIdentity: "rev1", selection: ["selected"], cwd: "/project" };
    it("uses the runner result even when a surrounding shell might exit successfully", () => {
        const claim = interpretTestClaim("All 3 executed tests passed.", scope)!;
        expect(verifyTestClaim(claim, { id: "r1", sourceIdentity: "rev1", selection: ["selected"], completion: "completed",
            runner: { success: false, numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0 } }).status).toBe("contradicted");
    });
    it("distinguishes command completion from successful typechecking and observed writes", () => {
        const receipt = { id: "r1", ...scope, completion: "completed" as const, exitCode: 2, signal: null,
            runner: "typescript" as const, directInvocation: true, outputComplete: true, sourceUnchanged: true, stdout: "", stderr: "error" };
        expect(verifyOperationalClaim(interpretOperationalClaim("Command completed.", scope)!, receipt).status).toBe("supported");
        expect(verifyOperationalClaim(interpretOperationalClaim("Typecheck completed cleanly.", scope)!, receipt).status).toBe("contradicted");
        expect(verifyOperationalClaim(interpretOperationalClaim("File `out.txt` was written.", scope)!, receipt).status).toBe("not_assessable");
    });
});
