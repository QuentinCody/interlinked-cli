// ===========================================
// Manual design-debt markers — read-only source scanner
// ===========================================
// Manual markers never read or mutate the pair-scoped obligation ledger.

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./audit-chain.js";
import {
    debtMarkerContentFingerprint,
    debtMarkerFingerprint,
    debtMarkerOccurrenceKey,
    explicitDebtMarkerFingerprint,
    extractDebtMarkerPayload,
    parseDebtMarkerPayload,
    supportsDebtMarkerComments,
    type DebtMarkerAdvisoryCode,
} from "./manual-debt-marker-parser.js";
import {
    DEFAULT_EXCLUDED_SEGMENTS,
    findingIds,
    isExcluded,
    normalizedExclusions,
    scanDate,
} from "./manual-debt-markers-default-excluded-segments.js";
import {
    advancePythonState,
    advanceSlashLanguageState,
    type DebtLexicalState,
} from "./manual-debt-markers-escaped-at.js";
import {
    repoRelative,
    repositoryIdentity,
    type DebtMarkerRepositoryIdentity,
} from "./manual-debt-markers-repository-identity.js";

export type { DebtMarkerRepositoryIdentity } from "./manual-debt-markers-repository-identity.js";

const MAX_SOURCE_BYTES = 1_048_576;

export interface ManualDebtMarker {
    fingerprint: string;
    content_fingerprint: string;
    file: string;
    line: number;
    decision: string;
    ceiling: string;
    trigger: string;
    id?: string | undefined;
    owner?: string | undefined;
    issue?: string | undefined;
    review?: string | undefined;
    review_after?: string | undefined;
    finding?: string | undefined;
}

export interface DebtMarkerAdvisory {
    fingerprint: string;
    file: string;
    line: number;
    code: DebtMarkerAdvisoryCode;
    message: string;
}

export interface DebtMarkerCoverage {
    roots: string[];
    /** Repository-relative files whose text was successfully read. */
    scanned_paths: string[];
    files_considered: number;
    files_scanned: number;
    lines_scanned: number;
    skipped: {
        binary: number;
        excluded: number;
        outside_project: number;
        symlink: number;
        too_large: number;
        unreadable: number;
        unsupported: number;
    };
    default_exclusions: string[];
    custom_exclusions: string[];
}

export interface DebtMarkerScanResult {
    schema_version: 1;
    source: "source-comments";
    repository: DebtMarkerRepositoryIdentity;
    markers: ManualDebtMarker[];
    advisories: DebtMarkerAdvisory[];
    coverage: DebtMarkerCoverage;
    obligation_ledger: { consulted: false; mutated: false };
    read_only: true;
}

interface ScanDebtMarkersOptions {
    cwd: string;
    roots?: string[] | undefined;
    exclude?: string[] | undefined;
    /** Injectable clock used only for stale review_after advisories. */
    clock?: (() => number) | undefined;
    /** Injectable common-corpus view for deterministic callers/tests. */
    knownFindingIds?: ReadonlySet<string> | undefined;
}

interface MarkerSite {
    file: string;
    line: number;
    payload: string;
}

function markerSitesInContent(file: string, content: string): MarkerSite[] {
    const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
    const python = extension === ".py" || extension === ".pyi";
    const slashLanguage = /\.(?:[cm]?[jt]sx?|cc|cpp|cs|dart|go|h|hpp|java|kt|kts|php|rs|scala|swift)$/.test(extension);
    const lines = content.split("\n");
    const sites: MarkerSite[] = [];
    let state: DebtLexicalState = "normal";
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (state === "normal") {
            const payload = extractDebtMarkerPayload(file, line);
            if (payload !== null) sites.push({ file, line: index + 1, payload });
        }
        if (python) state = advancePythonState(line, state);
        else if (slashLanguage) state = advanceSlashLanguageState(line, state);
    }
    return sites;
}

function emptyCoverage(roots: string[], custom: string[]): DebtMarkerCoverage {
    return {
        roots,
        scanned_paths: [],
        files_considered: 0,
        files_scanned: 0,
        lines_scanned: 0,
        skipped: {
            binary: 0,
            excluded: 0,
            outside_project: 0,
            symlink: 0,
            too_large: 0,
            unreadable: 0,
            unsupported: 0,
        },
        default_exclusions: [...DEFAULT_EXCLUDED_SEGMENTS].sort(),
        custom_exclusions: custom,
    };
}

function readDirectory(absolute: string, coverage: DebtMarkerCoverage): string[] {
    try {
        return readdirSync(absolute).sort();
    } catch (readError) {
        void readError;
        coverage.skipped.unreadable++;
        return [];
    }
}

function collectFiles(args: {
    projectRoot: string;
    absolute: string;
    custom: readonly string[];
    coverage: DebtMarkerCoverage;
    files: string[];
}): void {
    const rel = repoRelative(args.projectRoot, args.absolute);
    if (rel === null) {
        args.coverage.skipped.outside_project++;
        return;
    }
    if (rel !== "." && isExcluded(rel, args.custom)) {
        args.coverage.skipped.excluded++;
        return;
    }
    let stat: ReturnType<typeof lstatSync>;
    try {
        stat = lstatSync(args.absolute);
    } catch (statError) {
        void statError;
        args.coverage.skipped.unreadable++;
        return;
    }
    if (stat.isSymbolicLink()) {
        args.coverage.skipped.symlink++;
        return;
    }
    if (stat.isDirectory()) {
        for (const entry of readDirectory(args.absolute, args.coverage)) {
            collectFiles({ ...args, absolute: resolve(args.absolute, entry) });
        }
        return;
    }
    if (stat.isFile()) args.files.push(args.absolute);
}

function scanTextFile(args: {
    projectRoot: string;
    absolute: string;
    rel: string;
    coverage: DebtMarkerCoverage;
}): MarkerSite[] {
    try {
        if (statSync(args.absolute).size > MAX_SOURCE_BYTES) {
            args.coverage.skipped.too_large++;
            return [];
        }
        const content = readFileSync(args.absolute, "utf8");
        if (content.includes("\0")) {
            args.coverage.skipped.binary++;
            return [];
        }
        args.coverage.files_scanned++;
        args.coverage.scanned_paths.push(args.rel);
        args.coverage.lines_scanned += content.split("\n").length;
        return markerSitesInContent(args.rel, content);
    } catch (readError) {
        void readError;
        args.coverage.skipped.unreadable++;
        return [];
    }
}

function scanFile(
    projectRoot: string,
    absolute: string,
    coverage: DebtMarkerCoverage,
): MarkerSite[] {
    coverage.files_considered++;
    const rel = repoRelative(projectRoot, absolute);
    if (rel === null) {
        coverage.skipped.outside_project++;
        return [];
    }
    if (!supportsDebtMarkerComments(rel)) {
        coverage.skipped.unsupported++;
        return [];
    }
    return scanTextFile({ projectRoot, absolute, rel, coverage });
}

function materializeSite(
    site: MarkerSite,
    occurrences: Map<string, number>,
): { marker: ManualDebtMarker | null; advisories: DebtMarkerAdvisory[] } {
    const parsed = parseDebtMarkerPayload(site.payload);
    const identityMaterial = parsed.payload ? canonicalJson(parsed.payload) : site.payload;
    const occurrenceKey = debtMarkerOccurrenceKey(site.file, identityMaterial);
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    const fingerprint = parsed.payload?.id
        ? explicitDebtMarkerFingerprint(parsed.payload.id)
        : debtMarkerFingerprint(site.file, identityMaterial, occurrence);
    const advisories = parsed.issues.map((issue) => ({
        fingerprint,
        file: site.file,
        line: site.line,
        ...issue,
    }));
    if (!parsed.payload) return { marker: null, advisories };
    return {
        marker: {
            fingerprint,
            content_fingerprint: debtMarkerContentFingerprint(parsed.payload),
            file: site.file,
            line: site.line,
            ...parsed.payload,
        },
        advisories,
    };
}

function duplicateExplicitIds(markers: readonly ManualDebtMarker[]): Set<string> {
    const counts = new Map<string, number>();
    for (const marker of markers) {
        if (marker.id) counts.set(marker.id, (counts.get(marker.id) ?? 0) + 1);
    }
    return new Set(
        [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
    );
}

function markerLifecycleAdvisories(
    marker: ManualDebtMarker,
    duplicateIds: ReadonlySet<string>,
    today: string,
    knownFindingIds: ReadonlySet<string> | null,
): DebtMarkerAdvisory[] {
    const rows: DebtMarkerAdvisory[] = [];
    const base = { fingerprint: marker.fingerprint, file: marker.file, line: marker.line };
    if (marker.id && duplicateIds.has(marker.id)) {
        rows.push({
            ...base,
            code: "duplicate-id",
            message: `explicit marker id is not unique: ${marker.id}`,
        });
    }
    if (marker.review_after && marker.review_after < today) {
        rows.push({
            ...base,
            code: "stale-review",
            message: `review_after ${marker.review_after} is before ${today}`,
        });
    }
    if (marker.finding && knownFindingIds !== null && !knownFindingIds.has(marker.finding)) {
        rows.push({
            ...base,
            code: "missing-finding",
            message: `linked common-corpus finding does not exist: ${marker.finding}`,
        });
    }
    return rows;
}

function sortAdvisories(rows: DebtMarkerAdvisory[]): DebtMarkerAdvisory[] {
    return [...rows].sort((left, right) =>
        left.file.localeCompare(right.file)
        || left.line - right.line
        || left.code.localeCompare(right.code)
        || left.message.localeCompare(right.message));
}

function foldSites(
    sites: readonly MarkerSite[],
    projectRoot: string,
    options: Pick<ScanDebtMarkersOptions, "clock" | "knownFindingIds">,
): {
    markers: ManualDebtMarker[];
    advisories: DebtMarkerAdvisory[];
} {
    const occurrences = new Map<string, number>();
    const candidates: ManualDebtMarker[] = [];
    const advisories: DebtMarkerAdvisory[] = [];
    for (const site of sites) {
        const materialized = materializeSite(site, occurrences);
        advisories.push(...materialized.advisories);
        if (materialized.marker) candidates.push(materialized.marker);
    }
    const duplicates = duplicateExplicitIds(candidates);
    const today = scanDate(options.clock);
    const known = findingIds(projectRoot, options.knownFindingIds);
    for (const marker of candidates) {
        advisories.push(...markerLifecycleAdvisories(marker, duplicates, today, known));
    }
    const markers = candidates.filter((marker) => !marker.id || !duplicates.has(marker.id));
    return { markers, advisories: sortAdvisories(advisories) };
}

export function scanManualDebtMarkers(options: ScanDebtMarkersOptions): DebtMarkerScanResult {
    const projectRoot = resolve(options.cwd);
    const requestedRoots = options.roots?.length ? options.roots : ["."];
    const custom = normalizedExclusions(options.exclude ?? []);
    const coverage = emptyCoverage(requestedRoots, custom);
    const files: string[] = [];
    for (const root of requestedRoots) {
        collectFiles({ projectRoot, absolute: resolve(projectRoot, root), custom, coverage, files });
    }
    const scannedFiles = [...new Set(files)].sort();
    const sites = scannedFiles.flatMap((file) => scanFile(projectRoot, file, coverage));
    coverage.scanned_paths.sort();
    const folded = foldSites(sites, projectRoot, options);
    return {
        schema_version: 1,
        source: "source-comments",
        repository: repositoryIdentity(projectRoot, scannedFiles),
        ...folded,
        coverage,
        obligation_ledger: { consulted: false, mutated: false },
        read_only: true,
    };
}
