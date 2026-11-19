import { GENERATED_PATH, sourceRole, VENDOR_PATH } from "./inventory-roles.js";
import type { ExcludedFile, RoleEvidence, SourceRole } from "./measurement-types.js";
import { classifyByContent } from "./role-evidence-content.js";

/** A role together with the rule that set it. `from` names the path-only role when this layer changed it. */
export interface RoleDecision {
	role: SourceRole; evidence: RoleEvidence | null; from: SourceRole | null;
	/** Uniform structure alone: a candidate for generated output. The role stays what it was; only a report reads this. */
	candidate?: { dir: string; detail: string };
}

interface PathRule { pattern: RegExp; role: SourceRole; kind: "path" | "tool-path"; }

/** Committed package-manager and tool drops. The directory or file name is the whole claim: nobody on the team wrote it. */
const TOOL_PATH_RULES: readonly PathRule[] = [
	{ pattern: /(^|\/)\.yarn\/(?:releases|plugins|sdks)\//, role: "vendor", kind: "tool-path" },
	{ pattern: /(^|\/)\.pnp\.(?:c?js|loader\.mjs)$/, role: "vendor", kind: "tool-path" },
	{ pattern: /(^|\/)(?:third_party|third-party|vendored|bower_components)\//, role: "vendor", kind: "tool-path" },
	{ pattern: /\.min\.[cm]?js$/, role: "vendor", kind: "tool-path" },
];

/**
 * Generator output names. Only shapes that a code generator writes and a person does not: protobuf, the Kubernetes
 * `zz_generated.` prefix and a `_generated.<ext>` suffix. Languages that the inventory does not read as source (Dart) are assets already. `_gen` is deliberately absent: it also names hand-written
 * generator code.
 */
const GENERATED_NAME_RULES: readonly PathRule[] = [
	{ pattern: /\.pb\.(?:go|ts|js|cc|h|rs)$/, role: "generated", kind: "path" },
	{ pattern: /_pb\.(?:js|ts)$/, role: "generated", kind: "path" },
	{ pattern: /_pb2(?:_grpc)?\.pyi?$/, role: "generated", kind: "path" },
	{ pattern: /(^|\/)zz_generated\./, role: "generated", kind: "path" },
	{ pattern: /_generated\.[a-z0-9]+$/, role: "generated", kind: "path" },
];

/** Test support by directory name. Product only: `__mocks__` and test directories already classify as tests. */
const MOCK_DIRECTORY_RULE: PathRule = { pattern: /(^|\/)mocks\//, role: "test", kind: "path" };

function matched(pattern: RegExp, path: string): string | null {
	const found = pattern.exec(path);
	return found === null ? null : found[0].replace(/^\//, "");
}

function firstRule(rules: readonly PathRule[], path: string): { rule: PathRule; detail: string } | null {
	for (const rule of rules) {
		const detail = matched(rule.pattern, path);
		if (detail !== null) return { rule, detail };
	}
	return null;
}

function existingPathEvidence(path: string, base: SourceRole): RoleDecision {
	const pattern = base === "vendor" ? VENDOR_PATH : GENERATED_PATH;
	return { role: base, evidence: { kind: "path", detail: matched(pattern, path) ?? base }, from: null };
}

/**
 * Role from the path alone, with the rule that set it. The first step is `sourceRole`; the added rules only move a
 * `product` or `test` file, and never read content. Gates keep calling `sourceRole` directly and do not see these rules.
 */
export function classifyByPath(rawPath: string): RoleDecision {
	const path = rawPath.replaceAll("\\", "/");
	const base = sourceRole(path);
	if (base === "vendor" || base === "generated") return existingPathEvidence(path, base);
	if (base !== "product" && base !== "test") return { role: base, evidence: null, from: null };
	const hit = firstRule(TOOL_PATH_RULES, path) ?? firstRule(GENERATED_NAME_RULES, path)
		?? (base === "product" ? firstRule([MOCK_DIRECTORY_RULE], path) : null);
	if (hit === null) return { role: base, evidence: null, from: null };
	return { role: hit.rule.role, evidence: { kind: hit.rule.kind, detail: hit.detail }, from: base };
}

/** Second step: content may move an authored `product` file to `generated`. Tests are never moved (their evidence must stay whole). */
export function refineByContent(decision: RoleDecision, content: string): RoleDecision {
	if (decision.role !== "product") return decision;
	const found = classifyByContent(content);
	return found === null ? decision : { role: found.role, evidence: found.evidence, from: "product" };
}

/** Physical lines: a final line without a newline counts, an empty file has none. */
export function countLines(content: string): number {
	if (content === "") return 0;
	let lines = 0;
	for (let at = content.indexOf("\n"); at !== -1; at = content.indexOf("\n", at + 1)) lines++;
	return content.endsWith("\n") ? lines : lines + 1;
}

export function excludedEntry(path: string, decision: RoleDecision, lines?: number): ExcludedFile {
	const entry: ExcludedFile = { path, role: decision.role, reason: "Excluded by source-role policy" };
	if (decision.evidence !== null) entry.evidence = decision.evidence;
	if (decision.from !== null) entry.from = decision.from;
	if (lines !== undefined) entry.lines = lines;
	return entry;
}
