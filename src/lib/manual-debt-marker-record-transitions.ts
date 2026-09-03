// ===========================================
// Manual debt markers — transition derivation & lifecycle verification
// ===========================================
// Split out of manual-debt-marker-record.ts (line-cap extraction): computes
// opened/changed/closed transitions between two marker sets, materializes
// the resulting state, and re-derives a receipt's lifecycle for validation.

import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { canonicalJson } from "./audit-chain.js";
import type {
    ManualDebtMarkerSnapshotReceipt,
    ManualDebtMarkerTransition,
} from "./manual-debt-marker-record.js";
import type { DebtMarkerCoverage, DebtMarkerScanResult, ManualDebtMarker } from "./manual-debt-markers.js";

export function markerChanged(before: ManualDebtMarker, after: ManualDebtMarker): boolean {
    return before.file !== after.file || before.content_fingerprint !== after.content_fingerprint;
}

export function deriveManualDebtMarkerTransitions(
    before: readonly ManualDebtMarker[],
    after: readonly ManualDebtMarker[],
    closeWhen: (marker: ManualDebtMarker) => boolean = () => true,
): ManualDebtMarkerTransition[] {
    const prior = new Map(before.map((marker) => [marker.fingerprint, marker]));
    const current = new Map(after.map((marker) => [marker.fingerprint, marker]));
    const transitions: ManualDebtMarkerTransition[] = [];
    for (const marker of after) {
        const previous = prior.get(marker.fingerprint);
        if (!previous) {
            transitions.push({ action: "opened", fingerprint: marker.fingerprint, before: null, after: marker });
        } else if (markerChanged(previous, marker)) {
            transitions.push({ action: "changed", fingerprint: marker.fingerprint, before: previous, after: marker });
        }
    }
    for (const marker of before) {
        if (!current.has(marker.fingerprint) && closeWhen(marker)) {
            transitions.push({ action: "closed", fingerprint: marker.fingerprint, before: marker, after: null });
        }
    }
    return transitions.sort((left, right) =>
        left.fingerprint.localeCompare(right.fingerprint) || left.action.localeCompare(right.action));
}

export function materializeMarkerState(
    before: readonly ManualDebtMarker[],
    observed: readonly ManualDebtMarker[],
    transitions: readonly ManualDebtMarkerTransition[],
): ManualDebtMarker[] {
    const current = new Map(before.map((marker) => [marker.fingerprint, marker]));
    for (const marker of observed) current.set(marker.fingerprint, marker);
    for (const transition of transitions) {
        if (transition.action === "closed") current.delete(transition.fingerprint);
    }
    return [...current.values()].sort((left, right) =>
        left.fingerprint.localeCompare(right.fingerprint));
}

function pathInside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function pathExcluded(file: string, coverage: DebtMarkerCoverage): boolean {
    const segments = file.split("/");
    if (segments.some((segment) => coverage.default_exclusions.includes(segment))) return true;
    return coverage.custom_exclusions.some(
        (entry) => file === entry || file.startsWith(`${entry}/`),
    );
}

export function markerAbsenceVerified(
    scan: DebtMarkerScanResult,
    marker: ManualDebtMarker,
): boolean {
    if (scan.coverage.scanned_paths.includes(marker.file)) return true;
    if (pathExcluded(marker.file, scan.coverage)) return false;
    const absolute = resolve(scan.repository.root, marker.file);
    const selected = scan.coverage.roots.some((root) =>
        pathInside(resolve(scan.repository.root, root), absolute));
    return selected && !existsSync(absolute);
}

export function receiptLifecycleMatches(
    previous: ManualDebtMarkerSnapshotReceipt | null,
    current: ManualDebtMarkerSnapshotReceipt,
): boolean {
    const previousMarkers = previous?.materialized_markers ?? [];
    const expectedTransitions = deriveManualDebtMarkerTransitions(
        previousMarkers,
        current.scan.markers,
        (marker) => markerAbsenceVerified(current.scan, marker),
    );
    const expectedMaterialized = materializeMarkerState(
        previousMarkers,
        current.scan.markers,
        expectedTransitions,
    );
    return canonicalJson(current.transitions) === canonicalJson(expectedTransitions)
        && canonicalJson(current.materialized_markers) === canonicalJson(expectedMaterialized);
}
