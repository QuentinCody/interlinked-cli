// ===========================================
// CI / build-file command extractors
// ===========================================
//
// Pull executable command text out of CI and build files — GitHub workflow
// `run:` steps, Dockerfile `RUN` instructions, Makefile recipe lines — so the
// recurrence scanner can run the same destructive-command guard rules over
// commands that never reach a PreToolUse hook (they run in CI, not in an agent
// session). Adapted from destructive_command_guard's `dcg scan` surface, which
// walks the same file families; see docs/external-pulse/destructive-command-guard.md.
//
// These are deterministic, dependency-free line scanners — NOT full YAML /
// Dockerfile parsers. They aim for high recall on the command text (enough to
// feed a regex guard rule), not perfect fidelity. Per
// feedback_harness_deterministic_only.md: regex / line shape only, no LLM.

/** One command pulled out of a CI/build file. `line` is 1-based and points at
 *  the instruction that introduced the command (the `run:` / `RUN` / recipe
 *  line), so a finding can be cited as `file:line`. */
import { nonNull } from "../lib/non-null.js";

interface ExtractedCommand {
	line: number;
	command: string;
}

type CIFileKind = "workflow" | "dockerfile" | "makefile";

/** Classify a repo-relative path into a CI file family, or null. Matches on
 *  path shape only (never reads content). `docker-compose.yml` is deliberately
 *  excluded — its `command:` keys are container entrypoints, not shell steps. */
export function isCIFile(relPath: string): CIFileKind | null {
	const norm = relPath.split("\\").join("/");
	const base = norm.slice(norm.lastIndexOf("/") + 1);
	if (/^\.github\/workflows\/.+\.ya?ml$/.test(norm)) return "workflow";
	if (base === "Dockerfile" || base.endsWith(".Dockerfile") || base.startsWith("Dockerfile."))
		return "dockerfile";
	if (base === "Makefile" || base === "makefile" || base.endsWith(".mk")) return "makefile";
	return null;
}

/** Dispatch to the right extractor for a CI file; `[]` for non-CI paths. */
export function extractCICommands(relPath: string, content: string): ExtractedCommand[] {
	switch (isCIFile(relPath)) {
		case "workflow":
			return extractWorkflowCommands(content);
		case "dockerfile":
			return extractDockerfileCommands(content);
		case "makefile":
			return extractMakefileCommands(content);
		default:
			return [];
	}
}

/** Strip one layer of matching surrounding quotes. */
function unquote(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
		return t.slice(1, -1);
	}
	return t;
}

/** Leading-whitespace width (spaces/tabs) of a line. */
function indentOf(line: string): number {
	const m = line.match(/^[ \t]*/);
	return m ? m[0].length : 0;
}

/**
 * GitHub workflow `run:` steps. Handles the inline form (`run: cmd`) and YAML
 * block scalars (`run: |`, `run: >`, with optional `-`/`+` chomping). A block
 * body is every following line indented deeper than the `run:` key; it is
 * joined with newlines and handed to the guard as one script (the guard
 * already decomposes newlines/compounds).
 */
export function extractWorkflowCommands(content: string): ExtractedCommand[] {
	const lines = content.split("\n");
	const out: ExtractedCommand[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = nonNull(line).match(/^(\s*)(?:-\s+)?run:\s?(.*)$/);
		if (!m) continue;
		const keyIndent = (m[1] as string).length;
		const value = (m[2] as string).trim();
		const startLine = i + 1;

		if (/^[|>][+-]?\s*$/.test(value)) {
			// Block scalar: collect deeper-indented body lines.
			const body: string[] = [];
			let bodyIndent = -1;
			let j = i + 1;
			for (; j < lines.length; j++) {
				const bl = lines[j];
				if (nonNull(bl).trim() === "") {
					body.push("");
					continue;
				}
				const ind = indentOf(nonNull(bl));
				if (ind <= keyIndent) break;
				if (bodyIndent === -1) bodyIndent = ind;
				body.push(nonNull(bl).slice(Math.min(ind, bodyIndent)));
			}
			i = j - 1;
			const joined = body.join("\n").replace(/\n+$/, "").trim();
			if (joined) out.push({ line: startLine, command: joined });
		} else if (value) {
			out.push({ line: startLine, command: unquote(value) });
		}
	}
	return out;
}

/** Parse a JSON array, or null if `s` is not a valid JSON array literal. */
function tryParseJsonArray(s: string): unknown[] | null {
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v : null;
	} catch {
		return null; // not valid JSON — caller falls back to shell form
	}
}

/** Turn a RUN payload into a command string — JSON-array exec form joins its
 *  elements with spaces; shell form is taken verbatim. */
function parseDockerRun(rest: string): string {
	const trimmed = rest.trim();
	if (trimmed.startsWith("[")) {
		const arr = tryParseJsonArray(trimmed);
		if (arr) return arr.map((x) => String(x)).join(" ");
	}
	return trimmed;
}

/**
 * Dockerfile `RUN` instructions. Handles backslash line continuations and the
 * JSON-array exec form (`RUN ["a","b"]` → `a b`). Case-insensitive on the
 * instruction keyword. Other instructions (FROM/COPY/ENV/…) are ignored.
 */
export function extractDockerfileCommands(content: string): ExtractedCommand[] {
	const lines = content.split("\n");
	const out: ExtractedCommand[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = nonNull(lines[i]).match(/^\s*RUN\s+(.*)$/i);
		if (!m) continue;
		const startLine = i + 1;
		let rest = m[1] as string;
		// Join backslash continuations.
		while (rest.endsWith("\\") && i + 1 < lines.length) {
			rest = `${rest.slice(0, -1).trimEnd()} ${nonNull(lines[i + 1]).trim()}`;
			i++;
		}
		const command = parseDockerRun(rest);
		if (command) out.push({ line: startLine, command });
	}
	return out;
}

/**
 * Makefile recipe lines (tab-indented). Strips a single leading recipe-prefix
 * (`@` silent, `-` ignore-errors, `+` always-run) and joins backslash
 * continuations. Target, variable, and comment lines are skipped.
 */
export function extractMakefileCommands(content: string): ExtractedCommand[] {
	const lines = content.split("\n");
	const out: ExtractedCommand[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (nonNull(lines[i])[0] !== "\t") continue;
		const startLine = i + 1;
		let recipe = nonNull(lines[i]).slice(1);
		while (recipe.endsWith("\\") && i + 1 < lines.length) {
			recipe = `${recipe.slice(0, -1).trimEnd()} ${nonNull(lines[i + 1]).replace(/^\t/, "").trim()}`;
			i++;
		}
		const command = recipe.replace(/^[@\-+]+\s*/, "").trim();
		if (command) out.push({ line: startLine, command });
	}
	return out;
}
