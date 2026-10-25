import { describe, expect, it } from "vitest";
import { SpecLedger } from "./ledger.js";

const registry = ["# Four gates", "- G1 first", "- G2 second", "- G3 third", "- G4 fourth"].join("\n");
describe("count claim document scope", () => {
    it("does not treat a distant link as evidence for a README count", () => {
        const ledger = SpecLedger.fromContents("/repo", {
            "README.md": "There are two gates.\n\nOther topic.\n\nMore context.\n\nSee [registry](docs/gates.md).",
            "docs/gates.md": registry,
        }, () => true);
        expect(ledger.computeDrift().filter(finding => finding.kind === "count_claim_drift")).toEqual([]);
    });
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

// The same scope binds RANGE claims (2026-10-22): CLAUDE.md's plan-31 unit items "E1–E5" were compared with the
// experiment registry E18–E28 in docs/harness.md and fired on every CLAUDE.md edit.
const experiments = ["# Experiments", "- E18 filter", "- E19 scheduler", "- E28 replay"].join("\n");
describe("range claim document scope", () => {
    it("does not add an unrelated same-prefix registry beside the explicitly linked document", () => {
        const ledger = SpecLedger.fromContents("/repo", {
            "notes.md": "Experiments E18 through E28 ran. See [registry](docs/harness.md).",
            "docs/harness.md": experiments,
            "docs/unrelated.md": "# Other experiments\n- E90 first\n- E99 second",
        }, () => true);
        expect(ledger.computeDrift().filter((finding) => finding.kind === "range_claim_drift")).toEqual([]);
    });
    it("does not compare a root range claim with a same-prefix registry in another directory", () => {
        const ledger = SpecLedger.fromContents("/repo", {
            "CLAUDE.md": ["# Unit E", "- E1 snapshot identity", "- E2 stability", "Review round 1 fixed E1–E2."].join("\n"),
            "docs/harness.md": experiments,
        }, () => false);
        expect(ledger.computeDrift().filter((finding) => finding.kind === "range_claim_drift")).toEqual([]);
    });
    it("still compares a range claim with a registry it links to nearby in another directory", () => {
        const ledger = SpecLedger.fromContents("/repo", {
            "notes.md": ["- E18 first", "- E19 second", "Experiments E18 through E19 ran. See [registry](docs/harness.md)."].join("\n"),
            "docs/harness.md": experiments,
        }, () => true);
        expect(ledger.computeDrift().filter((finding) => finding.kind === "range_claim_drift")).toEqual([
            expect.objectContaining({ file: "notes.md", relatedFiles: ["docs/harness.md"], message: expect.stringContaining("E-28") }),
        ]);
    });
});
