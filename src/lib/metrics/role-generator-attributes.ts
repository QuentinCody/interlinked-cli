import { posix } from "node:path";
import type { ClaimSkip } from "./role-generator-claims.js";
import { compileGlob } from "./role-tool-glob.js";

/**
 * `.gitattributes` evidence: `linguist-generated` or `linguist-vendored`, set bare or `=true`. The owner wrote the line, so it names the
 * tool (git linguist) and the line. Git applies the last matching line, and a deeper `.gitattributes` wins over a shallower one. A pattern
 * matches a path, not the directory contents below it (unlike gitignore); a trailing-slash pattern is not valid and is skipped.
 */
export type AttributeKind = "generated" | "vendored";
export interface AttributeRule { file: string; line: number; dir: string; pattern: string; kind: AttributeKind; value: boolean; regex: RegExp; }

const ATTRIBUTE = /^(?<unset>[-!])?linguist-(?<kind>generated|vendored)(?:=(?<value>\S+))?$/;

function truthy(unset: string | undefined, value: string | undefined): boolean | null {
	if (unset === "!") return null;
	if (unset === "-") return false;
	return value === undefined || value === "true";
}

/** One attribute word of a line as a rule, a skip, or null when it is not a linguist generated/vendored attribute. */
function ruleFor(file: string, line: number, pattern: string, attribute: string): AttributeRule | ClaimSkip | null {
	const found = ATTRIBUTE.exec(attribute);
	if (found?.groups === undefined) return null;
	const value = truthy(found.groups.unset, found.groups.value);
	if (value === null) return null;
	const skip = (reason: string): ClaimSkip => ({ file, line, tool: "linguist", reason, pattern });
	if (pattern.endsWith("/")) return skip("trailing-slash");
	const compiled = compileGlob(pattern, "any-depth");
	if ("unsupported" in compiled) return skip(compiled.unsupported);
	const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
	return { file, line, dir, pattern, kind: found.groups.kind === "generated" ? "generated" : "vendored", value, regex: compiled.regex };
}

export function readAttributeRules(file: string, text: string): { rules: AttributeRule[]; skipped: ClaimSkip[] } {
	const rules: AttributeRule[] = [], skipped: ClaimSkip[] = [];
	for (const [index, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const [pattern = "", ...attributes] = line.split(/\s+/);
		for (const attribute of attributes) {
			const made = ruleFor(file, index + 1, pattern, attribute);
			if (made === null) continue;
			if ("regex" in made) rules.push(made); else skipped.push(made);
		}
	}
	return { rules, skipped };
}

/** The role that the attributes give a path, with the deciding rule, or null. Rules must be in file-depth then line order (`sortAttributeRules`). */
export function attributeVerdict(rules: readonly AttributeRule[], path: string): { role: "generated" | "vendor"; rule: AttributeRule } | null {
	const last = new Map<AttributeKind, AttributeRule>();
	for (const rule of sortAttributeRules(rules)) {
		if (rule.dir !== "" && !path.startsWith(`${rule.dir}/`)) continue;
		if (rule.regex.test(rule.dir === "" ? path : path.slice(rule.dir.length + 1))) last.set(rule.kind, rule);
	}
	const generated = last.get("generated"), vendored = last.get("vendored");
	if (generated?.value === true) return { role: "generated", rule: generated };
	if (vendored?.value === true) return { role: "vendor", rule: vendored };
	return null;
}

export function sortAttributeRules(rules: readonly AttributeRule[]): AttributeRule[] {
	return [...rules].sort((a, b) => a.dir.split("/").length - b.dir.split("/").length || a.file.localeCompare(b.file) || a.line - b.line);
}
