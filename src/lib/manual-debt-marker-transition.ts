// ===========================================
// Manual debt markers — single-transition parsing
// ===========================================
// Split out of manual-debt-marker-record.ts (line-cap extraction): parses one
// raw transition row into its typed shape, dispatching across the three
// lifecycle actions (opened/closed/changed).

import { isJsonObject } from "./json-types.js";
import type { ManualDebtMarker } from "./manual-debt-markers.js";
import {
    markerChanged,
    nonEmptyString,
    parseMarker,
    type ManualDebtMarkerTransition,
} from "./manual-debt-marker-record.js";

function tryOpenedTransition(
    action: unknown,
    fingerprint: string,
    before: ManualDebtMarker | null,
    after: ManualDebtMarker | null,
): ManualDebtMarkerTransition | null {
    if (action !== "opened" || before !== null || after?.fingerprint !== fingerprint) return null;
    return { action: "opened", fingerprint, before: null, after };
}

function tryClosedTransition(
    action: unknown,
    fingerprint: string,
    before: ManualDebtMarker | null,
    after: ManualDebtMarker | null,
): ManualDebtMarkerTransition | null {
    if (action !== "closed" || after !== null || before?.fingerprint !== fingerprint) return null;
    return { action: "closed", fingerprint, before, after: null };
}

function tryChangedTransition(
    action: unknown,
    fingerprint: string,
    before: ManualDebtMarker | null,
    after: ManualDebtMarker | null,
): ManualDebtMarkerTransition | null {
    if (
        action !== "changed"
        || before?.fingerprint !== fingerprint
        || after?.fingerprint !== fingerprint
        || !markerChanged(before, after)
    ) return null;
    return { action: "changed", fingerprint, before, after };
}

export function parseTransition(value: unknown): ManualDebtMarkerTransition | null {
    if (!isJsonObject(value)) return null;
    const fingerprint = nonEmptyString(value.fingerprint);
    if (!fingerprint) return null;
    const before = value.before === null ? null : parseMarker(value.before);
    const after = value.after === null ? null : parseMarker(value.after);
    if (value.before !== null && !before) return null;
    if (value.after !== null && !after) return null;
    return (
        tryOpenedTransition(value.action, fingerprint, before, after)
        ?? tryClosedTransition(value.action, fingerprint, before, after)
        ?? tryChangedTransition(value.action, fingerprint, before, after)
        ?? null
    );
}
