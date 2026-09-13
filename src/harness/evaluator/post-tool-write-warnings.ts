// interlinked-tdd: exempt
// ===========================================
// PostToolUse — post-write file quality warnings
// ===========================================
//
// File-level quality feedback after writes: size cap, JSON validity,
// package.json supply-chain checks, YAML tab detection, and
// suppression-comment justification. Extracted verbatim from post-tool.ts;
// the orchestrator calls only `collectPostWriteFileWarnings`.

import { readToolString } from "./tool-input-values.js";
import { readFileSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";
import { checkPhantomDependencies, checkTyposquatDependencies } from "../generic-checks.js";
import { countLines, isCappableFile, maxLinesFor } from "../large-file-policy.js";
import type { HarnessEvent } from "../types.js";
import { isFileWrite } from "./tool-classifiers.js";

/** File-level quality feedback after writes: size, JSON validity, supply-chain
 *  checks on package.json, YAML, and suppression-comment detection. */
export function collectPostWriteFileWarnings(event: HarnessEvent): string[] {
	const warnings: string[] = [];
	const toolName = event.tool_name || "";
	if (!isFileWrite(toolName)) return warnings;

	const filePath =
		readToolString(event.tool_input?.file_path) || readToolString(event.tool_input?.path);
	if (!filePath) return warnings;

	const ext = filePath.replace(/^.*\./, ".").toLowerCase();

	warnings.push(...collectFileSizeWriteWarning(event, filePath));
	if (ext === ".json") warnings.push(...collectJsonValidityWarning(filePath));
	if (filePath.endsWith("package.json") && !filePath.includes("node_modules")) {
		warnings.push(...collectSupplyChainWarnings(filePath));
	}
	if (ext === ".yaml" || ext === ".yml") warnings.push(...collectYamlValidityWarning(filePath));
	warnings.push(...collectSuppressionFileWarnings(filePath));
	return warnings;
}

/** File-size cap warning on write — only for hand-written code modules. */
function collectFileSizeWriteWarning(event: HarnessEvent, filePath: string): string[] {
	try {
		const root = event.cwd || process.cwd();
		const content = readFileSync(filePath, "utf-8");
		if (!isCappableFile({ filePath, content, root })) return [];
		const lineCount = countLines(content);
		const cap = maxLinesFor(root);
		if (lineCount > cap) {
			return [
				`[interlinked:file-size] ${filePath} is ${lineCount} lines — over the ${cap}-line cap for hand-written code. Consider splitting into smaller, focused modules.`,
			];
		}
	} catch (_err) {
		/* best-effort — skip when unreadable */
	}
	return [];
}

/** JSON syntax validity after a write to a `.json` file. */
function collectJsonValidityWarning(filePath: string): string[] {
	try {
		JSON.parse(readFileSync(filePath, "utf-8"));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("Dynamic require")) {
			return [`[interlinked:json-validity] ${filePath} contains invalid JSON: ${msg}. Fix the syntax error.`];
		}
	}
	return [];
}

/** Supply-chain checks (phantom + typosquat deps) after editing package.json. */
function collectSupplyChainWarnings(filePath: string): string[] {
	const warnings: string[] = [];
	for (const dep of checkPhantomDependencies(filePath)) {
		warnings.push(
			`[interlinked:supply-chain] ${dep.text}\n` +
				"  → If this dependency is intentional, ensure it is imported somewhere. " +
				"Phantom dependencies with lifecycle scripts are the primary npm supply chain attack vector.",
		);
	}
	for (const ts of checkTyposquatDependencies(filePath)) {
		warnings.push(
			`[interlinked:supply-chain] ${ts.text}\n` +
				"  → Typosquatted packages are a common supply chain attack vector. Double-check the package name.",
		);
	}
	return warnings;
}

/** YAML tab-indentation check after a write to a `.yaml` / `.yml` file. */
function collectYamlValidityWarning(filePath: string): string[] {
	try {
		const content = readFileSync(filePath, "utf-8");
		if (/\t/.test(content)) {
			return [
				`[interlinked:yaml-validity] ${filePath} contains tab characters. YAML requires spaces for indentation.`,
			];
		}
	} catch (_err) {
		/* best-effort — skip */
	}
	return [];
}

/** Suppression-comment detection after a write to a TS/JS file. */
function collectSuppressionFileWarnings(filePath: string): string[] {
	if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(filePath)) return [];
	try {
		return formatSuppressionWarnings(filePath, readFileSync(filePath, "utf-8"));
	} catch (_err) {
		/* best-effort — skip */
		return [];
	}
}

/**
 * Per Lopopolo's `hyperbola/require-eslint-disable-justification` rule:
 * suppression directives must carry a reason. A bare `// @ts-ignore` is the
 * most common AI escape hatch — silent bypass with no audit trail.
 *
 * The recognized justification conventions, by tool:
 *   - `@ts-ignore` / `@ts-expect-error`: any non-empty text after the
 *     directive counts (TypeScript itself doesn't enforce a separator;
 *     the de-facto convention is a colon or a space-prefixed reason)
 *   - `eslint-disable` (any flavor): ESLint 7+ requires the `--` separator
 *     before the reason, e.g. `// eslint-disable-next-line foo -- reason`
 *   - `biome-ignore`: Biome requires a colon, e.g.
 *     `// biome-ignore lint/foo: reason`
 *   - `@ts-nocheck`: file-level directive with no per-line justification
 *     convention; not enforced here (just counted as informational)
 *   - `v8 ignore` / `c8 ignore` / `istanbul ignore` / `node:coverage ignore`:
 *     the coverage-ignore pragmas. They are suppressions of the coverage
 *     ratchet — a pragma'd line leaves the denominator entirely, so the file's
 *     percentage rises with no test written. The convention is the ESLint one,
 *     ` -- reason`: a `v8 ignore next` hint followed by
 *     ` -- child-process-only path`, inside either comment form. It is chosen
 *     because the installed provider still honors the hint with the suffix
 *     present: ast-v8-to-istanbul's `ignore-hints.ts` matches
 *     `/^\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(if|else|next|file)(?=\W|$)/`
 *     after stripping the comment markers, and the `(?=\W|$)` lookahead
 *     accepts any non-word character (a space) after the hint word — verified
 *     empirically, not by reading alone.
 */
const SUPPRESSION_DIRECTIVES: ReadonlyArray<{
	label: string;
	re: RegExp;
	isJustified: (suffix: string) => boolean;
}> = [
	{
		label: "@ts-ignore",
		re: /\/\/\s*@ts-ignore\b([^\n]*)/,
		isJustified: (suffix) => /\S/.test(suffix.replace(/^[: \t]+/, "")),
	},
	{
		label: "@ts-expect-error",
		re: /\/\/\s*@ts-expect-error\b([^\n]*)/,
		isJustified: (suffix) => /\S/.test(suffix.replace(/^[: \t]+/, "")),
	},
	{
		label: "@ts-nocheck",
		re: /\/\/\s*@ts-nocheck\b([^\n]*)/,
		// File-level, no per-line justification convention — exempt.
		isJustified: () => true,
	},
	{
		label: "eslint-disable",
		re: /\/\/\s*eslint-disable(?:-next-line|-line)?\b([^\n]*)/,
		// ESLint 7+ convention: `// eslint-disable-next-line rule -- reason`.
		isJustified: (suffix) => / -- \S/.test(suffix),
	},
	{
		label: "biome-ignore",
		re: /\/\/\s*biome-ignore\b([^\n]*)/,
		// Biome convention: `// biome-ignore lint/foo: reason` (colon).
		isJustified: (suffix) => /:\s*\S/.test(suffix),
	},
	{
		label: "coverage-ignore",
		// Both comment forms: the block form is the idiomatic one for these
		// pragmas, and the provider strips `//`, `/*` and `/**` alike before
		// matching. The tool tokens and hint words are the provider's own sets
		// (istanbul / c8 / v8 / node:coverage; if/else/next/file/start/stop).
		// `next` tolerates trailing text — which is exactly what the ` -- reason`
		// convention relies on — but ast-v8-to-istanbul 1.0.3 does NOT honor a
		// line COUNT there: measured, a `next 3` hint suppresses one node, not
		// three (the provider regex captures only the hint word). The example
		// is written without comment delimiters on purpose — this matcher is
		// unanchored, so a quoted pragma inside prose would match itself.
		re: /(?:\/\/|\/\*+)\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next|file|start|stop)\b([^\n]*)/,
		// ESLint's ` -- reason` separator, chosen because the provider's
		// `(?=\W|$)` lookahead tolerates it. The closing `*/` of the block
		// form is stripped first so it is never mistaken for a reason.
		isJustified: (suffix) => / -- \S/.test(suffix.replace(/\*+\/\s*$/, "")),
	},
];

interface SuppressionCounts {
	justified: number;
	unjustifiedLines: number[];
}

function analyzeSuppressions(content: string): Map<string, SuppressionCounts> {
	const byLabel = new Map<string, SuppressionCounts>();
	const lines = content.split("\n");
	for (const [i, line] of lines.entries()) {
		for (const { label, re, isJustified } of SUPPRESSION_DIRECTIVES) {
			const match = re.exec(line);
			if (!match) continue;
			// Every directive regex captures the suffix, including an empty suffix.
			const suffix = nonNull(match[1]);
			const counts = byLabel.get(label) ?? { justified: 0, unjustifiedLines: [] };
			if (isJustified(suffix)) counts.justified++;
			else counts.unjustifiedLines.push(i + 1);
			byLabel.set(label, counts);
		}
	}
	return byLabel;
}

/** Maximum line numbers shown inline before truncating with an ellipsis. */
const MAX_LINES_SHOWN = 5;

function formatSuppressionWarnings(filePath: string, content: string): string[] {
	const byLabel = analyzeSuppressions(content);
	const unjustifiedParts: string[] = [];
	const justifiedParts: string[] = [];
	for (const [label, { justified, unjustifiedLines }] of byLabel) {
		if (unjustifiedLines.length > 0) {
			const shown = unjustifiedLines.slice(0, MAX_LINES_SHOWN).join(", ");
			const more = unjustifiedLines.length > MAX_LINES_SHOWN ? ", …" : "";
			unjustifiedParts.push(
				`${unjustifiedLines.length}x ${label} (lines: ${shown}${more})`,
			);
		}
		if (justified > 0) justifiedParts.push(`${justified}x ${label}`);
	}

	const out: string[] = [];
	if (unjustifiedParts.length > 0) {
		out.push(
			`[interlinked:suppressions-unjustified] ${filePath} has bare suppression comments without a reason: ` +
				`${unjustifiedParts.join(", ")}. Add a justification: ` +
				"`// @ts-ignore: <reason>`, `// eslint-disable-next-line <rule> -- <reason>`, " +
				"`// biome-ignore lint/<rule>: <reason>`, " +
				"or `v8 ignore next -- <reason>` (same ` -- ` separator; the coverage " +
				"provider still honors the hint with the reason attached). " +
				"Bare disables silently bypass safety; justified ones leave an audit trail for reviewers.",
		);
	}
	if (justifiedParts.length > 0 && unjustifiedParts.length === 0) {
		out.push(
			`[interlinked:suppressions] ${filePath} has suppression comments (${justifiedParts.join(", ")}). ` +
				"All carry justifications — consider whether the underlying issue can be fixed instead of silenced.",
		);
	}
	return out;
}
