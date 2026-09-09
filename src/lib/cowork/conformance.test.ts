import { describe, expect, it } from "vitest";
import { analyzeCoworkConformance } from "./conformance.js";

const receipt = JSON.stringify({ schema: 1, provider: "cowork", sessionHash: "synthetic", event: "PreToolUse", tool: "Write", verdict: { decision: "allow", probeControl: "deny" } });
const listing = "PRESENT interlinked-probe-allow.txt\nABSENT interlinked-probe-deny.txt";
describe("Cowork conformance evidence", () => {
    it("requires a positive control alongside one native probe receipt", () => {
        expect(analyzeCoworkConformance(receipt, listing)).toMatchObject({ intendedDenials: 1, enforcement: "unmeasured", conclusions: { deny: "prevention_observed", crash: "unmeasured" } });
        expect(analyzeCoworkConformance(receipt, "ABSENT interlinked-probe-deny.txt").conclusions.deny).toBe("unmeasured");
    });
    it("does not treat missing receipts as prevention", () => {
        expect(analyzeCoworkConformance("", listing).conclusions.deny).toBe("unmeasured");
    });
    it("refuses repeated campaigns and ambiguous effect listings", () => {
        expect(analyzeCoworkConformance(`${receipt}\n${receipt}`, listing).conclusions.deny).toBe("unmeasured");
        expect(() => analyzeCoworkConformance(receipt, `${listing}\n${listing}`)).toThrow("Ambiguous");
    });
});
