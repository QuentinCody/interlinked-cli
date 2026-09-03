// ===========================================
// Manual debt markers — explicit snapshot lifecycle
// ===========================================
// Source comments remain authoritative. Recording appends a snapshot receipt
// and derives opened/changed/closed transitions from the prior valid snapshot;
// it never reads or mutates the automatic obligation ledger.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "./audit-chain.js";
import { interlinkedPath } from "./interlinked-path.js";
import { isJsonObject } from "./json-types.js";
import {
    nonEmptyString,
    nullableString,
    parseDebtMarkerScanResult,
    parseMarker,
    parsedList,
    uniqueCanonical,
} from "./manual-debt-marker-record-parse.js";
import {
    deriveManualDebtMarkerTransitions,
    markerAbsenceVerified,
    materializeMarkerState,
    receiptLifecycleMatches,
} from "./manual-debt-marker-record-transitions.js";
import { parseTransition } from "./manual-debt-marker-transition.js";
import type { DebtMarkerScanResult, ManualDebtMarker } from "./manual-debt-markers.js";

const RECEIPT_SCHEMA_VERSION = 1 as const;
const RECEIPT_FILE = "manual-marker-snapshots.jsonl";

export type ManualDebtMarkerTransitionAction = "opened" | "changed" | "closed";

export interface ManualDebtMarkerTransition {
    action: ManualDebtMarkerTransitionAction;
    fingerprint: string;
    before: ManualDebtMarker | null;
    after: ManualDebtMarker | null;
}

export interface ManualDebtMarkerSnapshotReceipt {
    schema_version: typeof RECEIPT_SCHEMA_VERSION;
    kind: "manual_debt_marker_snapshot";
    snapshot_fingerprint: string;
    previous_snapshot_fingerprint: string | null;
    recorded_at: string;
    reason: string | null;
    scan: DebtMarkerScanResult;
    /** Full current state after carrying markers outside a partial scan as unknown. */
    materialized_markers: ManualDebtMarker[];
    transitions: ManualDebtMarkerTransition[];
}

interface RecordManualDebtMarkerOptions {
    reason?: string | undefined;
    now?: string | undefined;
    clock?: (() => number) | undefined;
}

export interface ManualDebtMarkerRecordResult {
    receipt: ManualDebtMarkerSnapshotReceipt;
    receipt_path: string;
    opened: number;
    changed: number;
    closed: number;
}

function sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export function manualDebtMarkerSnapshotsPath(cwd: string): string {
    return interlinkedPath(resolve(cwd), "debt", RECEIPT_FILE);
}

type SnapshotFingerprintMaterial = Pick<
    ManualDebtMarkerSnapshotReceipt,
    | "previous_snapshot_fingerprint"
    | "recorded_at"
    | "reason"
    | "scan"
    | "materialized_markers"
    | "transitions"
>;

export function manualDebtMarkerSnapshotFingerprint(
    material: SnapshotFingerprintMaterial,
): string {
    return sha256(`manual-debt-marker-snapshot/v2\0${canonicalJson(material)}`);
}

export function parseManualDebtMarkerSnapshotReceipt(
    value: unknown,
): ManualDebtMarkerSnapshotReceipt | null {
    if (!isJsonObject(value) || value.schema_version !== RECEIPT_SCHEMA_VERSION) return null;
    if (value.kind !== "manual_debt_marker_snapshot") return null;
    const snapshotFingerprint = nonEmptyString(value.snapshot_fingerprint);
    const previousFingerprint = nullableString(value.previous_snapshot_fingerprint);
	const recordedAt = nonEmptyString(value.recorded_at);
    const reason = nullableString(value.reason);
    const scan = parseDebtMarkerScanResult(value.scan);
    const materializedMarkers = parsedList(value.materialized_markers, parseMarker);
    const transitions = parsedList(value.transitions, parseTransition);
	if (
		!snapshotFingerprint
		|| previousFingerprint === undefined
		|| !recordedAt
		|| !Number.isFinite(Date.parse(recordedAt))
	) return null;
    if (reason === undefined || !scan || !materializedMarkers || !transitions) return null;
    if (!uniqueCanonical(materializedMarkers.map((marker) => marker.fingerprint))) return null;
    const fingerprintMaterial: SnapshotFingerprintMaterial = {
        previous_snapshot_fingerprint: previousFingerprint,
        recorded_at: recordedAt,
        reason,
        scan,
        materialized_markers: materializedMarkers,
        transitions,
    };
    if (manualDebtMarkerSnapshotFingerprint(fingerprintMaterial) !== snapshotFingerprint) return null;
    return {
        schema_version: RECEIPT_SCHEMA_VERSION,
        kind: "manual_debt_marker_snapshot",
        snapshot_fingerprint: snapshotFingerprint,
        previous_snapshot_fingerprint: previousFingerprint,
        recorded_at: recordedAt,
        reason,
        scan,
        materialized_markers: materializedMarkers,
        transitions,
    };
}

/** Missing, malformed, and torn rows are skipped; valid history stays readable. */
export function loadManualDebtMarkerSnapshotReceipts(
    cwd: string,
): ManualDebtMarkerSnapshotReceipt[] {
    const path = manualDebtMarkerSnapshotsPath(cwd);
    if (!existsSync(path)) return [];
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (readError) {
        void readError;
        return [];
    }
    const rows: ManualDebtMarkerSnapshotReceipt[] = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
            const parsed = parseManualDebtMarkerSnapshotReceipt(JSON.parse(line));
            const previous = rows.at(-1) ?? null;
            const expectedPrevious = previous?.snapshot_fingerprint ?? null;
            if (
                parsed?.previous_snapshot_fingerprint === expectedPrevious
                && receiptLifecycleMatches(previous, parsed)
            ) rows.push(parsed);
        } catch (parseError) {
            void parseError;
            // Preserve every earlier valid append when the tail is torn.
        }
    }
    return rows;
}

function tornTailPrefix(path: string): string {
    if (!existsSync(path)) return "";
    try {
        const bytes = readFileSync(path);
        return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? "\n" : "";
    } catch (readError) {
        void readError;
        return "";
    }
}

function recordedAt(options: RecordManualDebtMarkerOptions): string {
    const value = options.now ?? new Date((options.clock ?? Date.now)()).toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new Error("recorded_at must be a valid timestamp");
    return value;
}

function recordReason(value: string | undefined): string | null {
    if (value === undefined) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error("record reason must not be empty");
    return trimmed;
}

export function recordManualDebtMarkerSnapshot(
    scanValue: DebtMarkerScanResult,
    cwd: string,
    options: RecordManualDebtMarkerOptions = {},
): ManualDebtMarkerRecordResult {
    const root = resolve(cwd);
    const scan = parseDebtMarkerScanResult(scanValue);
    if (!scan) throw new Error("refusing to record an invalid manual debt-marker scan");
    if (resolve(scan.repository.root) !== root) {
        throw new Error("manual debt-marker scan repository does not match recording root");
    }
    const history = loadManualDebtMarkerSnapshotReceipts(root);
    const previous = history.at(-1) ?? null;
    const previousMarkers = previous?.materialized_markers ?? [];
    const transitions = deriveManualDebtMarkerTransitions(
        previousMarkers,
        scan.markers,
        (marker) => markerAbsenceVerified(scan, marker),
    );
    const recorded_at = recordedAt(options);
    const reason = recordReason(options.reason);
    const materialized_markers = materializeMarkerState(previousMarkers, scan.markers, transitions);
    const fingerprintMaterial: SnapshotFingerprintMaterial = {
        previous_snapshot_fingerprint: previous?.snapshot_fingerprint ?? null,
        recorded_at,
        reason,
        scan,
        materialized_markers,
        transitions,
    };
    const receipt: ManualDebtMarkerSnapshotReceipt = {
        schema_version: RECEIPT_SCHEMA_VERSION,
        kind: "manual_debt_marker_snapshot",
        snapshot_fingerprint: manualDebtMarkerSnapshotFingerprint(fingerprintMaterial),
        ...fingerprintMaterial,
    };
    const path = manualDebtMarkerSnapshotsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${tornTailPrefix(path)}${JSON.stringify(receipt)}\n`, "utf8");
    const transitionCount = (action: ManualDebtMarkerTransitionAction): number =>
        transitions.filter((transition) => transition.action === action).length;
    return {
        receipt,
        receipt_path: path,
        opened: transitionCount("opened"),
        changed: transitionCount("changed"),
        closed: transitionCount("closed"),
    };
}
