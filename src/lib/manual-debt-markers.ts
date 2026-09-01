// ===========================================
// Manual design-debt markers — read-only source scanner
// ===========================================
// Manual markers never read or mutate the pair-scoped obligation ledger.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { loadFindings } from "../harness/findings/corpus.js";
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

const MAX_SOURCE_BYTES = 1_048_576;

const DEFAULT_EXCLUDED_SEGMENTS = new Set([
    ".cache",
    ".git",
    ".interlinked",
    ".next",
    ".nuxt",
    "__fixtures__",
    "bower_components",
    "build",
    "coverage",
    "dist",
    "docs",
    "examples",
    "fixtures",
    "generated",
    "node_modules",
    "out",
    "target",
    "temp",
    "tmp",
    "vendor",
]);

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

export interface DebtMarkerRepositoryIdentity {
    root: string;
    head_sha: string | null;
    tree_sha: string | null;
    working_tree_sha256: string;
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

type DebtLexicalState = "normal" | "block-comment" | "template" | "triple-single" | "triple-double";

function escapedAt(line: string, index: number): boolean {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) slashes++;
    return slashes % 2 === 1;
}

function unescapedTokenIndex(line: string, token: string, from: number): number {
    let index = line.indexOf(token, from);
    while (index >= 0 && escapedAt(line, index)) index = line.indexOf(token, index + token.length);
    return index;
}

function advanceSlashLanguageState(line: string, initial: DebtLexicalState): DebtLexicalState {
    let state = initial;
    for (let index = 0; index < line.length; index++) {
        if (state === "block-comment") {
            if (line.slice(index, index + 2) === "*/") {
                state = "normal";
                index++;
            }
            continue;
        }
        if (state === "template") {
            if (line[index] === "`" && !escapedAt(line, index)) state = "normal";
            continue;
        }
        const pair = line.slice(index, index + 2);
        if (pair === "//") break;
        if (pair === "/*") {
            state = "block-comment";
            index++;
            continue;
        }
        if (line[index] === "`") {
            state = "template";
            continue;
        }
        const quote = line[index];
        if (quote !== undefined && (quote === "\"" || quote === "'")) {
            const closing = unescapedTokenIndex(line, quote, index + 1);
            index = closing < 0 ? line.length : closing;
        }
    }
    return state;
}

function advancePythonState(line: string, initial: DebtLexicalState): DebtLexicalState {
    let state = initial;
    for (let index = 0; index < line.length; index++) {
        const triple = state === "triple-single" ? "'''" : '"""';
        if (state === "triple-single" || state === "triple-double") {
            if (line.slice(index, index + 3) === triple && !escapedAt(line, index)) {
                state = "normal";
                index += 2;
            }
            continue;
        }
        if (line[index] === "#") break;
        const opening = line.slice(index, index + 3);
        if (opening === "'''" || opening === '"""') {
            state = opening === "'''" ? "triple-single" : "triple-double";
            index += 2;
            continue;
        }
        const quote = line[index];
        if (quote !== undefined && (quote === "\"" || quote === "'")) {
            const closing = unescapedTokenIndex(line, quote, index + 1);
            index = closing < 0 ? line.length : closing;
        }
    }
    return state;
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

function repoRelative(projectRoot: string, absolute: string): string | null {
    const rel = relative(projectRoot, absolute);
    if (rel === "") return ".";
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(projectRoot, rel) !== absolute) {
        return null;
    }
    return rel.split(sep).join("/");
}

function gitValue(projectRoot: string, args: string[]): string | null {
    try {
        const value = execFileSync("git", args, {
            cwd: projectRoot,
            encoding: "utf8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        return value.length > 0 ? value : null;
    } catch (gitError) {
        void gitError;
        return null;
    }
}

function workingTreeFingerprint(projectRoot: string, files: readonly string[]): string {
    const hash = createHash("sha256");
    for (const absolute of [...files].sort()) {
        const rel = repoRelative(projectRoot, absolute) ?? absolute;
        hash.update(rel);
        hash.update("\0");
        try {
            hash.update(readFileSync(absolute));
        } catch (readError) {
            void readError;
            hash.update("<unreadable>");
        }
        hash.update("\0");
    }
    return hash.digest("hex");
}

function repositoryIdentity(
    projectRoot: string,
    files: readonly string[],
): DebtMarkerRepositoryIdentity {
    return {
        root: projectRoot,
        head_sha: gitValue(projectRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
        tree_sha: gitValue(projectRoot, ["rev-parse", "--verify", "HEAD^{tree}"]),
        working_tree_sha256: workingTreeFingerprint(projectRoot, files),
    };
}

function scanDate(clock: (() => number) | undefined): string {
    const date = new Date((clock ?? Date.now)());
    if (!Number.isFinite(date.getTime())) throw new Error("debt marker scan clock is invalid");
    return date.toISOString().slice(0, 10);
}

function findingIds(projectRoot: string, supplied?: ReadonlySet<string>): ReadonlySet<string> | null {
    if (supplied) return supplied;
    try {
        return new Set(loadFindings(projectRoot).map((finding) => finding.id));
    } catch (corpusError) {
        void corpusError;
        // Finding linkage is advisory. An unreadable corpus must not turn every
        // link into a false "missing" row.
        return null;
    }
}

function normalizedExclusions(values: readonly string[]): string[] {
    return values
        .map((value) => value.trim().replace(/^\.\//, "").replace(/\/$/, ""))
        .filter(Boolean)
        .sort();
}

function isExcluded(rel: string, custom: readonly string[]): boolean {
    if (rel.split("/").some((segment) => DEFAULT_EXCLUDED_SEGMENTS.has(segment))) return true;
    return custom.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
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
