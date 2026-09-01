// ===========================================
// Manual design-debt marker format
// ===========================================
// A marker is one source-aware line comment whose payload is a JSON object.
// Parsing is advisory: malformed rows become diagnostics, never exceptions.

import { createHash } from "node:crypto";
import { extname } from "node:path";
import { canonicalJson } from "./audit-chain.js";
import { isJsonObject, type JsonObject } from "./json-types.js";

const MARKER_TOKEN = "interlinked-debt:";

const SLASH_EXTENSIONS = new Set([
    ".c", ".cc", ".cpp", ".cs", ".cts", ".dart", ".go", ".h", ".hpp", ".java",
    ".js", ".jsx", ".kt", ".kts", ".mjs", ".mts", ".php", ".rs", ".scala",
    ".swift", ".ts", ".tsx",
]);
const HASH_EXTENSIONS = new Set([
    ".bash", ".cfg", ".fish", ".ini", ".jl", ".pl", ".py", ".pyi", ".r",
    ".rb", ".sh", ".toml", ".yaml", ".yml", ".zsh",
]);
const DASH_EXTENSIONS = new Set([".hs", ".lua", ".sql"]);
const SEMICOLON_EXTENSIONS = new Set([".clj", ".cljs", ".edn", ".el", ".lisp"]);
const HTML_EXTENSIONS = new Set([".htm", ".html", ".xml"]);

export const DEBT_MARKER_ADVISORY_CODES = [
    "ambiguous-decision",
    "duplicate-id",
    "invalid-field",
    "invalid-review-date",
    "malformed-json",
    "missing-finding",
    "missing-ceiling",
    "missing-decision",
    "no-trigger",
    "stale-review",
    "unknown-field",
] as const;

export type DebtMarkerAdvisoryCode = (typeof DEBT_MARKER_ADVISORY_CODES)[number];

interface DebtMarkerPayload {
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

interface DebtMarkerPayloadIssue {
    code: DebtMarkerAdvisoryCode;
    message: string;
}

interface ParsedDebtMarkerPayload {
    payload: DebtMarkerPayload | null;
    issues: DebtMarkerPayloadIssue[];
}

interface CommentSyntax {
    prefix: string;
    suffix?: string | undefined;
}

function commentSyntax(file: string): CommentSyntax | null {
    const extension = extname(file).toLowerCase();
    if (SLASH_EXTENSIONS.has(extension)) return { prefix: "//" };
    if (HASH_EXTENSIONS.has(extension)) return { prefix: "#" };
    if (DASH_EXTENSIONS.has(extension)) return { prefix: "--" };
    if (SEMICOLON_EXTENSIONS.has(extension)) return { prefix: ";" };
    if (HTML_EXTENSIONS.has(extension)) return { prefix: "<!--", suffix: "-->" };
    const base = file.split("/").at(-1)?.toLowerCase();
    return base === "dockerfile" || base === "makefile" ? { prefix: "#" } : null;
}

export function supportsDebtMarkerComments(file: string): boolean {
    return commentSyntax(file) !== null;
}

export function extractDebtMarkerPayload(file: string, line: string): string | null {
    const syntax = commentSyntax(file);
    if (!syntax) return null;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(syntax.prefix)) return null;
    let comment = trimmed.slice(syntax.prefix.length).trimStart();
    if (!comment.startsWith(MARKER_TOKEN)) return null;
    comment = comment.slice(MARKER_TOKEN.length).trim();
    if (syntax.suffix && comment.endsWith(syntax.suffix)) {
        comment = comment.slice(0, -syntax.suffix.length).trimEnd();
    }
    return comment;
}

function normalizeForFingerprint(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

/** Stable across unrelated line movement. The duplicate ordinal distinguishes
 * two byte-equivalent decisions in one file without including the line. */
export function debtMarkerFingerprint(file: string, raw: string, occurrence: number): string {
    const material = `${file}\0${normalizeForFingerprint(raw)}\0${occurrence}`;
    return `debt-${createHash("sha256").update(material).digest("hex").slice(0, 20)}`;
}

/** An explicit id owns identity across path and marker-content changes. The
 * readable id remains on the marker; the fingerprint is a bounded safe key. */
export function explicitDebtMarkerFingerprint(id: string): string {
    const material = `manual-debt-explicit-id/v1\0${id.trim()}`;
    return `debt-${createHash("sha256").update(material).digest("hex").slice(0, 20)}`;
}

/** Hash the semantic marker payload independently of its identity and source
 * location. Key order and whitespace do not create a false "changed" event. */
export function debtMarkerContentFingerprint(payload: DebtMarkerPayload): string {
    const content = {
        decision: payload.decision,
        ceiling: payload.ceiling,
        trigger: payload.trigger,
        ...(payload.owner ? { owner: payload.owner } : {}),
        ...(payload.issue ? { issue: payload.issue } : {}),
        ...(payload.review ? { review: payload.review } : {}),
        ...(payload.review_after ? { review_after: payload.review_after } : {}),
        ...(payload.finding ? { finding: payload.finding } : {}),
    };
    return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function debtMarkerOccurrenceKey(file: string, raw: string): string {
    return `${file}\0${normalizeForFingerprint(raw)}`;
}

function stringField(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isIsoCalendarDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number.parseInt(match[1] ?? "", 10);
    const month = Number.parseInt(match[2] ?? "", 10);
    const day = Number.parseInt(match[3] ?? "", 10);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.toISOString().slice(0, 10) === value;
}

/** A prose-only "when needed" is not a measurable upgrade boundary. */
export function isMeasurableDebtTrigger(trigger: string): boolean {
    return /(?:>=|<=|===|==|>|<)|\b\d+(?:\.\d+)?\s*(?:%|ms|s|m|h|d|kb|mb|gb|tb|x|users?|requests?|items?|files?|days?|weeks?|months?|years?)\b/i.test(
        trigger,
    );
}

function coreIssues(parsed: JsonObject): DebtMarkerPayloadIssue[] {
    const decision = stringField(parsed.decision);
    const shortcut = stringField(parsed.shortcut);
    const issues: DebtMarkerPayloadIssue[] = [];
    if (!decision && !shortcut) {
        issues.push({ code: "missing-decision", message: "marker requires decision or shortcut" });
    }
    if (decision && shortcut && decision !== shortcut) {
        issues.push({
            code: "ambiguous-decision",
            message: "decision and shortcut disagree; keep one canonical value",
        });
    }
    if (!stringField(parsed.ceiling)) {
        issues.push({ code: "missing-ceiling", message: "marker requires ceiling" });
    }
    const trigger = stringField(parsed.trigger);
    if (!trigger || !isMeasurableDebtTrigger(trigger)) {
        issues.push({
            code: "no-trigger",
            message: "trigger must include a measurable threshold or comparison",
        });
    }
    return issues;
}

function optionalFieldIssues(parsed: JsonObject): DebtMarkerPayloadIssue[] {
    const issues: DebtMarkerPayloadIssue[] = [];
    const allowed = new Set([
        "decision", "shortcut", "ceiling", "trigger", "id", "owner", "issue",
        "review", "review_after", "finding",
    ]);
    for (const key of Object.keys(parsed)) {
        if (!allowed.has(key)) {
            issues.push({ code: "unknown-field", message: `unknown marker field: ${key}` });
        }
    }
    for (const key of ["id", "owner", "issue", "review", "review_after", "finding"] as const) {
        if (parsed[key] !== undefined && stringField(parsed[key]) === null) {
            issues.push({ code: "invalid-field", message: `${key} must be a non-empty string` });
        }
    }
    const reviewAfter = stringField(parsed.review_after);
    if (reviewAfter && !isIsoCalendarDate(reviewAfter)) {
        issues.push({
            code: "invalid-review-date",
            message: "review_after must be a real ISO date (YYYY-MM-DD)",
        });
    }
    return issues;
}

function buildPayload(parsed: JsonObject): DebtMarkerPayload | null {
    const decision = stringField(parsed.decision) ?? stringField(parsed.shortcut);
    const ceiling = stringField(parsed.ceiling);
    const trigger = stringField(parsed.trigger);
    if (!decision || !ceiling || !trigger) return null;
    const id = stringField(parsed.id);
    const owner = stringField(parsed.owner);
    const issue = stringField(parsed.issue);
    const review = stringField(parsed.review);
    const review_after = stringField(parsed.review_after);
    const finding = stringField(parsed.finding);
    return {
        decision,
        ceiling,
        trigger,
        ...(id ? { id } : {}),
        ...(owner ? { owner } : {}),
        ...(issue ? { issue } : {}),
        ...(review ? { review } : {}),
        ...(review_after ? { review_after } : {}),
        ...(finding ? { finding } : {}),
    };
}

export function parseDebtMarkerPayload(raw: string): ParsedDebtMarkerPayload {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {
            payload: null,
            issues: [{ code: "malformed-json", message: "marker payload is not valid JSON" }],
        };
    }
    if (!isJsonObject(parsed)) {
        return {
            payload: null,
            issues: [{ code: "malformed-json", message: "marker payload must be a JSON object" }],
        };
    }
    const issues = [...coreIssues(parsed), ...optionalFieldIssues(parsed)];
    return { payload: issues.length === 0 ? buildPayload(parsed) : null, issues };
}
