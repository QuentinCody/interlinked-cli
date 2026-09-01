// ===========================================
// Manual debt markers — explicit snapshot lifecycle
// ===========================================
// Source comments remain authoritative. Recording appends a snapshot receipt
// and derives opened/changed/closed transitions from the prior valid snapshot;
// it never reads or mutates the automatic obligation ledger.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./audit-chain.js";
import { interlinkedPath } from "./interlinked-path.js";
import { isJsonObject } from "./json-types.js";
import {
    DEBT_MARKER_ADVISORY_CODES,
    type DebtMarkerAdvisoryCode,
} from "./manual-debt-marker-parser.js";
import type {
    DebtMarkerAdvisory,
    DebtMarkerCoverage,
    DebtMarkerRepositoryIdentity,
    DebtMarkerScanResult,
    ManualDebtMarker,
} from "./manual-debt-markers.js";

const RECEIPT_SCHEMA_VERSION = 1 as const;
const RECEIPT_FILE = "manual-marker-snapshots.jsonl";

type ManualDebtMarkerTransitionAction = "opened" | "changed" | "closed";

interface ManualDebtMarkerTransition {
    action: ManualDebtMarkerTransitionAction;
    fingerprint: string;
    before: ManualDebtMarker | null;
    after: ManualDebtMarker | null;
}

interface ManualDebtMarkerSnapshotReceipt {
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

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
    if (value === null) return null;
    return nonEmptyString(value) ?? undefined;
}

function optionalString(value: unknown): string | undefined | null {
    if (value === undefined) return undefined;
    return nonEmptyString(value);
}

function stringList(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    return value.every((item): item is string => typeof item === "string") ? [...value] : null;
}

function count(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function repositoryPath(value: string): boolean {
    if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
    if (/^[A-Za-z]:/.test(value)) return false;
    return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function uniqueCanonical(values: readonly string[]): boolean {
    return new Set(values).size === values.length
        && values.every((entry, index) => index === 0 || entry >= (values[index - 1] ?? ""));
}

function parseRepository(value: unknown): DebtMarkerRepositoryIdentity | null {
    if (!isJsonObject(value)) return null;
    const root = nonEmptyString(value.root);
    const headSha = nullableString(value.head_sha);
    const treeSha = nullableString(value.tree_sha);
    const workingTreeSha = nonEmptyString(value.working_tree_sha256);
    if (!root || headSha === undefined || treeSha === undefined || !workingTreeSha) return null;
    return {
        root,
        head_sha: headSha,
        tree_sha: treeSha,
        working_tree_sha256: workingTreeSha,
    };
}

function markerOptionalFields(value: Record<string, unknown>): Partial<ManualDebtMarker> | null {
    const id = optionalString(value.id);
    const owner = optionalString(value.owner);
    const issue = optionalString(value.issue);
    const review = optionalString(value.review);
    const reviewAfter = optionalString(value.review_after);
    const finding = optionalString(value.finding);
    if ([id, owner, issue, review, reviewAfter, finding].some((item) => item === null)) return null;
    return {
        ...(id ? { id } : {}),
        ...(owner ? { owner } : {}),
        ...(issue ? { issue } : {}),
        ...(review ? { review } : {}),
        ...(reviewAfter ? { review_after: reviewAfter } : {}),
        ...(finding ? { finding } : {}),
    };
}

function parseMarker(value: unknown): ManualDebtMarker | null {
    if (!isJsonObject(value)) return null;
    const fingerprint = nonEmptyString(value.fingerprint);
    const contentFingerprint = nonEmptyString(value.content_fingerprint);
    const file = nonEmptyString(value.file);
    const line = count(value.line);
    const decision = nonEmptyString(value.decision);
    const ceiling = nonEmptyString(value.ceiling);
    const trigger = nonEmptyString(value.trigger);
    const optional = markerOptionalFields(value);
    if (!fingerprint || !contentFingerprint || !file || !repositoryPath(file)) return null;
    if (line === null || line < 1) return null;
    if (!decision || !ceiling || !trigger || !optional) return null;
    return {
        fingerprint,
        content_fingerprint: contentFingerprint,
        file,
        line,
        decision,
        ceiling,
        trigger,
        ...optional,
    };
}

function advisoryCode(value: unknown): DebtMarkerAdvisoryCode | null {
    return DEBT_MARKER_ADVISORY_CODES.find((code) => code === value) ?? null;
}

function parseAdvisory(value: unknown): DebtMarkerAdvisory | null {
    if (!isJsonObject(value)) return null;
    const fingerprint = nonEmptyString(value.fingerprint);
    const file = nonEmptyString(value.file);
    const line = count(value.line);
    const code = advisoryCode(value.code);
    const message = nonEmptyString(value.message);
    return fingerprint && file && repositoryPath(file) && line !== null && line >= 1 && code && message
        ? { fingerprint, file, line, code, message }
        : null;
}

function constructSkipped(value: Record<string, unknown>): DebtMarkerCoverage["skipped"] | null {
    const binary = count(value.binary);
    const excluded = count(value.excluded);
    const outsideProject = count(value.outside_project);
    const symlink = count(value.symlink);
    const tooLarge = count(value.too_large);
    const unreadable = count(value.unreadable);
    const unsupported = count(value.unsupported);
    if (binary === null || excluded === null || outsideProject === null || symlink === null) {
        return null;
    }
    if (tooLarge === null || unreadable === null || unsupported === null) return null;
    return {
        binary,
        excluded,
        outside_project: outsideProject,
        symlink,
        too_large: tooLarge,
        unreadable,
        unsupported,
    };
}

function parseSkipped(value: unknown): DebtMarkerCoverage["skipped"] | null {
    return isJsonObject(value) ? constructSkipped(value) : null;
}

function coveragePathsValid(scannedPaths: readonly string[], filesScanned: number): boolean {
    return scannedPaths.length === filesScanned
        && scannedPaths.every(repositoryPath)
        && uniqueCanonical(scannedPaths);
}

function parseCoverage(value: unknown): DebtMarkerCoverage | null {
    if (!isJsonObject(value)) return null;
    const roots = stringList(value.roots);
    const scannedPaths = stringList(value.scanned_paths);
    const filesConsidered = count(value.files_considered);
    const filesScanned = count(value.files_scanned);
    const linesScanned = count(value.lines_scanned);
    const skipped = parseSkipped(value.skipped);
    const defaultExclusions = stringList(value.default_exclusions);
    const customExclusions = stringList(value.custom_exclusions);
    if (!roots || !scannedPaths || filesConsidered === null || filesScanned === null || linesScanned === null) {
        return null;
    }
    if (!skipped || !defaultExclusions || !customExclusions) return null;
    if (!coveragePathsValid(scannedPaths, filesScanned)) return null;
    return {
        roots,
        scanned_paths: scannedPaths,
        files_considered: filesConsidered,
        files_scanned: filesScanned,
        lines_scanned: linesScanned,
        skipped,
        default_exclusions: defaultExclusions,
        custom_exclusions: customExclusions,
    };
}

function parsedList<T>(value: unknown, parser: (item: unknown) => T | null): T[] | null {
    if (!Array.isArray(value)) return null;
    const rows: T[] = [];
    for (const item of value) {
        const parsed = parser(item);
        if (!parsed) return null;
        rows.push(parsed);
    }
    return rows;
}

function scanMembersMatchCoverage(
    markers: readonly ManualDebtMarker[],
    advisories: readonly DebtMarkerAdvisory[],
    coverage: DebtMarkerCoverage,
): boolean {
    const scanned = new Set(coverage.scanned_paths);
    const uniqueMarkers = new Set(markers.map((marker) => marker.fingerprint)).size === markers.length;
    return uniqueMarkers
        && markers.every((marker) => scanned.has(marker.file))
        && advisories.every((advisory) => scanned.has(advisory.file));
}

function parseDebtMarkerScanResult(value: unknown): DebtMarkerScanResult | null {
    if (!isJsonObject(value) || value.schema_version !== 1) return null;
    if (value.source !== "source-comments" || value.read_only !== true) return null;
    const repository = parseRepository(value.repository);
    const markers = parsedList(value.markers, parseMarker);
    const advisories = parsedList(value.advisories, parseAdvisory);
    const coverage = parseCoverage(value.coverage);
    if (!repository || !markers || !advisories || !coverage) return null;
    if (!scanMembersMatchCoverage(markers, advisories, coverage)) return null;
    if (!isJsonObject(value.obligation_ledger)) return null;
    if (value.obligation_ledger.consulted !== false || value.obligation_ledger.mutated !== false) {
        return null;
    }
    return {
        schema_version: 1,
        source: "source-comments",
        repository,
        markers,
        advisories,
        coverage,
        obligation_ledger: { consulted: false, mutated: false },
        read_only: true,
    };
}

function markerChanged(before: ManualDebtMarker, after: ManualDebtMarker): boolean {
    return before.file !== after.file || before.content_fingerprint !== after.content_fingerprint;
}

function deriveManualDebtMarkerTransitions(
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

function materializeMarkerState(
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

function markerAbsenceVerified(
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

function parseTransition(value: unknown): ManualDebtMarkerTransition | null {
    if (!isJsonObject(value)) return null;
    const fingerprint = nonEmptyString(value.fingerprint);
    if (!fingerprint) return null;
    const before = value.before === null ? null : parseMarker(value.before);
    const after = value.after === null ? null : parseMarker(value.after);
    if (value.before !== null && !before) return null;
    if (value.after !== null && !after) return null;
    if (value.action === "opened" && before === null && after?.fingerprint === fingerprint) {
        return { action: "opened", fingerprint, before: null, after };
    }
    if (value.action === "closed" && after === null && before?.fingerprint === fingerprint) {
        return { action: "closed", fingerprint, before, after: null };
    }
    if (value.action === "changed" && before?.fingerprint === fingerprint
        && after?.fingerprint === fingerprint && markerChanged(before, after)) {
        return { action: "changed", fingerprint, before, after };
    }
    return null;
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

function receiptLifecycleMatches(
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
