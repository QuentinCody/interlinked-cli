import { describe, expect, it } from "vitest";
import type { ManualDebtMarkerSnapshotReceipt } from "./manual-debt-marker-record.js";
import {
    deriveManualDebtMarkerTransitions,
    markerAbsenceVerified,
    markerChanged,
    materializeMarkerState,
    receiptLifecycleMatches,
} from "./manual-debt-marker-record-transitions.js";
import type { DebtMarkerScanResult, ManualDebtMarker } from "./manual-debt-markers.js";

function marker(overrides: Partial<ManualDebtMarker> = {}): ManualDebtMarker {
    return {
        fingerprint: "fp-1",
        content_fingerprint: "cf-1",
        file: "src/cache.ts",
        line: 10,
        decision: "single-process cache",
        ceiling: "10k keys",
        trigger: "keys > 10000 items",
        ...overrides,
    };
}

function scan(overrides: Partial<DebtMarkerScanResult> = {}): DebtMarkerScanResult {
    return {
        schema_version: 1,
        source: "source-comments",
        repository: {
            root: "/repo",
            head_sha: null,
            tree_sha: null,
            working_tree_sha256: "abc",
        },
        markers: [],
        advisories: [],
        coverage: {
            roots: ["src"],
            scanned_paths: ["src/cache.ts"],
            files_considered: 1,
            files_scanned: 1,
            lines_scanned: 10,
            skipped: {
                binary: 0,
                excluded: 0,
                outside_project: 0,
                symlink: 0,
                too_large: 0,
                unreadable: 0,
                unsupported: 0,
            },
            default_exclusions: ["node_modules"],
            custom_exclusions: [],
        },
        obligation_ledger: { consulted: false, mutated: false },
        read_only: true,
        ...overrides,
    };
}

describe("markerChanged", () => {
    it("flags a changed file or content fingerprint (positive)", () => {
        expect(markerChanged(marker(), marker({ file: "src/other.ts" }))).toBe(true);
        expect(markerChanged(marker(), marker({ content_fingerprint: "cf-2" }))).toBe(true);
    });

    it("reports unchanged when file and content fingerprint match (negative)", () => {
        expect(markerChanged(marker(), marker({ line: 99 }))).toBe(false);
    });
});

describe("deriveManualDebtMarkerTransitions", () => {
    it("opens a marker present only in the after set (positive)", () => {
        const transitions = deriveManualDebtMarkerTransitions([], [marker()]);
        expect(transitions).toEqual([
            { action: "opened", fingerprint: "fp-1", before: null, after: marker() },
        ]);
    });

    it("does not close a marker when closeWhen rejects it (negative)", () => {
        const transitions = deriveManualDebtMarkerTransitions([marker()], [], () => false);
        expect(transitions).toEqual([]);
    });
});

describe("materializeMarkerState", () => {
    it("keeps observed markers and drops closed ones (positive)", () => {
        const before = [marker()];
        const transitions = deriveManualDebtMarkerTransitions(before, []);
        expect(materializeMarkerState(before, [], transitions)).toEqual([]);
    });

    it("retains a marker with no matching transition (negative)", () => {
        const before = [marker()];
        expect(materializeMarkerState(before, [marker()], [])).toEqual([marker()]);
    });
});

describe("markerAbsenceVerified", () => {
    it("verifies absence when the marker's root was scanned and the file is gone (positive)", () => {
        expect(markerAbsenceVerified(scan(), marker({ file: "src/gone.ts" }))).toBe(true);
    });

    it("refuses absence for an excluded path (negative)", () => {
        expect(markerAbsenceVerified(scan(), marker({ file: "node_modules/pkg/x.ts" }))).toBe(false);
    });
});

describe("receiptLifecycleMatches", () => {
    it("accepts a receipt whose transitions match derivation from the prior state (positive)", () => {
        const currentScan = scan({ markers: [marker()] });
        const transitions = deriveManualDebtMarkerTransitions(
            [],
            currentScan.markers,
            (m) => markerAbsenceVerified(currentScan, m),
        );
        const materialized = materializeMarkerState([], currentScan.markers, transitions);
        // SAFETY: receiptLifecycleMatches only reads scan/transitions/materialized_markers.
        const receipt = {
            scan: currentScan,
            transitions,
            materialized_markers: materialized,
        } as unknown as ManualDebtMarkerSnapshotReceipt;
        expect(receiptLifecycleMatches(null, receipt)).toBe(true);
    });

    it("rejects a receipt whose transitions were fabricated (negative)", () => {
        const currentScan = scan({ markers: [marker()] });
        // SAFETY: receiptLifecycleMatches only reads scan/transitions/materialized_markers.
        const receipt = {
            scan: currentScan,
            transitions: [],
            materialized_markers: [],
        } as unknown as ManualDebtMarkerSnapshotReceipt;
        expect(receiptLifecycleMatches(null, receipt)).toBe(false);
    });
});
