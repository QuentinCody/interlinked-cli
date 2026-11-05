import { describe, expect, it } from "vitest";
import { SpecLedger } from "./ledger.js";

const registry = ["# Four gates", "- G1 first", "- G2 second", "- G3 third", "- G4 fourth"].join("\n");

function driftFor(readme: string) {
	const ledger = SpecLedger.fromContents("/repo", { "README.md": readme, "docs/gates.md": registry }, () => true);
	return ledger.computeDrift().filter((finding) => finding.kind === "count_claim_drift");
}

// Census fault: `> LINK_PROXIMITY_LINES` → `>=` survived the companion test
// (docs/reviews/kill-proof-census-harness.md).
describe("count claim scope — link proximity boundary", () => {
	// test-contract: boundary — a link exactly three lines from the claim is near enough to bind the registry
	it("compares a claim with a registry linked exactly three lines below", () => {
		expect(driftFor("There are two gates.\nOne.\nTwo.\nSee [registry](docs/gates.md).")).toEqual([
			expect.objectContaining({ file: "README.md", relatedFiles: ["docs/gates.md"] }),
		]);
	});

	// test-contract: boundary — four lines away is out of range
	it("ignores a registry linked four lines below", () => {
		expect(driftFor("There are two gates.\nOne.\nTwo.\nThree.\nSee [registry](docs/gates.md).")).toEqual([]);
	});
});
