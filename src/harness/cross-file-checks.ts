// ===========================================
// Cross-File Taste Checks
// ===========================================
// Checks that require the full project graph:
//   - Duplicate switch discriminant across files → polymorphism candidate
//   - Interface with exactly one implementor → premature abstraction signal
// Both run in runStructuralChecks on PostToolUse.

import { readFileSync } from "node:fs";
import { nonNull } from "../lib/non-null.js";
import type { ProjectGraph } from "./project-graph.js";
import type { StructuralCheckResult } from "./types.js";

const SWITCH_DISC = /\bswitch\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\)/g;
const DISC_TAIL = /\.(kind|type|tag|variant|_tag)$/;

function safeRead(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function lineOfOffset(content: string, offset: number): number {
	return content.slice(0, offset).split("\n").length;
}

function collectDiscriminants(content: string): Set<string> {
	const out = new Set<string>();
	for (const m of content.matchAll(SWITCH_DISC)) {
		if (DISC_TAIL.test(nonNull(m[1]))) out.add(nonNull(m[1]));
	}
	return out;
}

function findDiscriminantEcho(
	disc: string,
	filePath: string,
	relPath: string,
	graph: ProjectGraph,
): StructuralCheckResult | null {
	const otherFiles: string[] = [];
	for (const other of graph.allFiles()) {
		if (other === filePath) continue;
		const oc = safeRead(other);
		if (!oc) continue;
		// Reason: `disc` is a discriminant identifier extracted from a
		// TS switch's parsed AST; dots are escaped for property access.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		if (new RegExp(`\\bswitch\\s*\\(\\s*${disc.replace(/\./g, "\\.")}\\s*\\)`).test(oc)) {
			otherFiles.push(other);
			if (otherFiles.length >= 5) break;
		}
	}
	if (otherFiles.length === 0) return null;
	const relList = otherFiles
		.slice(0, 3)
		.map((f) => graph.toRelative(f))
		.join(", ");
	return {
		check: "cross_file_switch_discriminant",
		severity: "warning",
		message: `${relPath} switches on \`${disc}\` — also seen in ${otherFiles.length} other file(s): ${relList}${
			otherFiles.length > 3 ? ", …" : ""
		}. Consider a polymorphic dispatch or strategy registry.`,
		file: filePath,
		affectedFiles: otherFiles,
	};
}

export function checkCrossFileSwitchDiscriminant(
	filePath: string,
	relPath: string,
	graph: ProjectGraph,
): StructuralCheckResult[] {
	const content = safeRead(filePath);
	if (!content) return [];
	const mine = collectDiscriminants(content);
	if (mine.size === 0) return [];

	const results: StructuralCheckResult[] = [];
	for (const disc of mine) {
		const result = findDiscriminantEcho(disc, filePath, relPath, graph);
		if (result) results.push(result);
	}
	return results;
}

const IMPL_EXTENDS = /\b(?:implements|extends)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/g;

function mentionsAsImpl(content: string, name: string): boolean {
	IMPL_EXTENDS.lastIndex = 0;
	for (const m of content.matchAll(IMPL_EXTENDS)) {
		const names = nonNull(m[1]).split(",").map((n) => n.trim());
		if (names.includes(name)) return true;
	}
	return false;
}

export function checkSingleImplementationInterface(
	filePath: string,
	_relPath: string,
	graph: ProjectGraph,
): StructuralCheckResult[] {
	const exports = graph.getExports(filePath);
	const interfaces = exports.filter((e) => e.kind === "interface");
	if (interfaces.length === 0) return [];

	const results: StructuralCheckResult[] = [];
	for (const iface of interfaces) {
		const implementors: string[] = [];
		for (const other of graph.allFiles()) {
			if (other === filePath) continue;
			const oc = safeRead(other);
			if (!oc) continue;
			if (mentionsAsImpl(oc, iface.name)) {
				implementors.push(other);
				if (implementors.length > 1) break;
			}
		}
		if (implementors.length !== 1) continue;
		results.push({
			check: "single_implementation_interface",
			severity: "info",
			message: `Interface \`${iface.name}\` has exactly one implementor (${graph.toRelative(
				nonNull(implementors[0]),
			)}). Premature abstraction? Consider inlining or making it concrete.`,
			file: filePath,
			affectedFiles: implementors,
		});
	}
	return results;
}

export { lineOfOffset };
