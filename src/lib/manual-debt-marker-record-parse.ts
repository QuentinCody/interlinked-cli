// ===========================================
// Manual debt markers — scan-result parsing/validation
// ===========================================
// Split out of manual-debt-marker-record.ts (line-cap extraction): the pure
// validation layer that turns raw JSON into typed, invariant-checked scan
// results and markers. No I/O, no fingerprinting — those stay in the parent.

import { isJsonObject } from "./json-types.js";
import { DEBT_MARKER_ADVISORY_CODES, type DebtMarkerAdvisoryCode } from "./manual-debt-marker-parser.js";
import type {
    DebtMarkerAdvisory,
    DebtMarkerCoverage,
    DebtMarkerRepositoryIdentity,
    DebtMarkerScanResult,
    ManualDebtMarker,
} from "./manual-debt-markers.js";

export function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

export function nullableString(value: unknown): string | null | undefined {
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

export function uniqueCanonical(values: readonly string[]): boolean {
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

export function parseMarker(value: unknown): ManualDebtMarker | null {
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

export function parsedList<T>(value: unknown, parser: (item: unknown) => T | null): T[] | null {
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

export function parseDebtMarkerScanResult(value: unknown): DebtMarkerScanResult | null {
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
