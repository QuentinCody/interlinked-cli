import { expect, it } from "vitest";
import type { ManualDebtMarker } from "./manual-debt-markers.js";
import { parseTransition } from "./manual-debt-marker-transition.js";

const marker = (fingerprint: string): ManualDebtMarker => ({
	fingerprint, content_fingerprint: "cf-1", file: "src/cache.ts", line: 10,
	decision: "single-process cache", ceiling: "10k keys", trigger: "keys > 10000 items",
});

// test-contract: invariant — a closed transition must close the marker it names; a record whose `before` marker carries a different fingerprint is corrupt and must be refused, or the ledger closes the wrong debt
it("rejects a closed transition whose before fingerprint mismatches", () => {
	expect(parseTransition({ action: "closed", fingerprint: "fp-1", before: marker("fp-2"), after: null })).toBeNull();
});
