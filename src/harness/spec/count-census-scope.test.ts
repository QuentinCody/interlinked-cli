import { describe, expect, it } from "vitest";
import { SpecLedger } from "./ledger.js";

const registry = ["# Four gates", "- G1 first", "- G2 second", "- G3 third", "- G4 fourth"].join("\n");
describe("count claim document scope", () => {
    it("does not compare unrelated sibling documents merely because their nouns match", () => {
        const ledger = SpecLedger.fromContents("/repo", {
            "docs/design/data-rollout.md": "At this snapshot, 17 catalog sources have receipts.",
            "docs/design/memory.md": "# Four sources\n- M1 first\n- M2 second\n- M3 third\n- M4 fourth",
        }, () => false);
        expect(ledger.computeDrift().filter((finding) => finding.kind === "count_claim_drift")).toEqual([]);
    });
    it("keeps an explicitly referenced sibling registry in scope", () => {
        const ledger = SpecLedger.fromContents("/repo", {
            "docs/design/data-rollout.md": "There are two gates. See [registry](gates.md).",
            "docs/design/gates.md": registry,
        }, () => true);
        expect(ledger.computeDrift().filter((finding) => finding.kind === "count_claim_drift")).toEqual([
            expect.objectContaining({ file: "docs/design/data-rollout.md", relatedFiles: ["docs/design/gates.md"] }),
        ]);
    });
    it("does not bind an unrelated root count to a nested design registry", () => {
        const ledger = SpecLedger.fromContents("/repo", { "CLAUDE.md": "# Harness\nThere are two gates.", "docs/repro/README.md": registry }, () => false);
        expect(ledger.computeDrift().filter((finding) => finding.kind === "count_claim_drift")).toEqual([]);
    });
    it("compares a nearby explicitly linked registry and retains both provenances", () => {
        const ledger = SpecLedger.fromContents("/repo", { "README.md": "There are two gates. See [registry](docs/repro/README.md).", "docs/repro/README.md": registry }, () => true);
        expect(ledger.computeDrift().filter((finding) => finding.kind === "count_claim_drift")).toEqual([
            expect.objectContaining({ file: "README.md", relatedFiles: ["docs/repro/README.md"] }),
        ]);
    });
});
