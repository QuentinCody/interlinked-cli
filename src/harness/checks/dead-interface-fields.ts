// ===========================================
// Cross-module dead-interface-field detector
// ===========================================
//
// Why this exists:
// TypeScript and most linters catch unused *types* and *exports* fine, but
// there's a blind spot: a public interface declares a field, types compile
// because somebody assigns to it, but nothing in production code ever
// reads the field. The only consumer is the field's own colocated test
// (which asserts the literal value of the property, then never uses it for
// anything functional). The result: dead spec.
//
// Concrete failure mode this catches: `HarnessModePreset.quality_checks_enabled`
// in `src/harness/rules/modes.ts`. The presets all declared a populated
// map; the modes test asserted the map's contents row-by-row; but no
// loader code read the field, so `interlinked harness mode budget` only
// changed the hook timeout while the daemon kept running heavy checks at
// their built-in defaults. A reviewer caught it.
//
// Limitations (these are why this is a CI-time check, not PostToolUse):
// - Heuristic regex, not full AST traversal. Doesn't follow re-exports,
//   doesn't understand inherited interfaces, doesn't handle dynamic
//   property names (`obj[someVar]`).
// - Scope is intentionally narrow: callers point this at one source dir.
//   The full codebase has a lot of legitimate cross-package dead-looking
//   fields (e.g. `HarnessDecision._escalation` is read only inside the
//   daemon's processEvent — looks dead from a grep but isn't).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface DeadFieldFinding {
	/** Path of the file declaring the dead field, relative to `searchRoot`. */
	file: string;
	/** 1-indexed line of the field declaration. */
	line: number;
	/** Interface or type alias the field belongs to. */
	containerName: string;
	/** The field name itself. */
	field: string;
}

interface InterfaceField {
	file: string;
	line: number;
	containerName: string;
	field: string;
}

const SRC_FILE_RE = /\.(ts|tsx)$/;
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;
const INTERFACE_OPEN_RE = /^\s*export\s+interface\s+([A-Z]\w*)\s*(?:extends\s+[^{]+)?\{?\s*$/;
// Property declarations: `name?: Type;` / `name: Type,`. Just require a
// valid identifier (with optional `?`) followed by `:` followed by
// something. We can't constrain the type body with `[^;,\n]+` because
// generic types like `Record<string, boolean>` contain commas. Method
// signatures (`log(msg): void`) are filtered separately by checking
// that no `(` appears before the first `:`.
const FIELD_DECL_RE = /^\s*([a-z_][\w]*)\s*\??\s*:\s*\S/i;

function* walkSourceFiles(root: string): Iterable<string> {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch (_) {
		return;
	}
	for (const name of entries) {
		if (name === "node_modules" || name === "dist" || name === "build") continue;
		if (name.startsWith(".")) continue;
		const full = join(root, name);
		let s;
		try {
			s = statSync(full);
		} catch (_) {
			continue;
		}
		if (s.isDirectory()) {
			yield* walkSourceFiles(full);
		} else if (s.isFile() && SRC_FILE_RE.test(name)) {
			yield full;
		}
	}
}

interface InterfaceLineResult {
	activeContainer: string | null;
	braceDepth: number;
	field: InterfaceField | null;
}

// Scans one source line against the current (activeContainer, braceDepth)
// state and returns the updated state plus a field record when the line
// declares a top-level interface property. Pulled out of
// `extractInterfaceFields`'s loop body so that loop stays flat: this
// function's own branches never nest inside another loop or if.
function scanInterfaceLine(
	line: string,
	lineIndex: number,
	file: string,
	activeContainer: string | null,
	braceDepth: number,
): InterfaceLineResult {
	const open = INTERFACE_OPEN_RE.exec(line);
	if (open) {
		return { activeContainer: open[1] ?? null, braceDepth: 1, field: null };
	}
	if (activeContainer === null) {
		return { activeContainer, braceDepth, field: null };
	}

	braceDepth += (line.match(/\{/g) || []).length;
	braceDepth -= (line.match(/\}/g) || []).length;
	if (braceDepth <= 0) {
		return { activeContainer: null, braceDepth, field: null };
	}
	// Only record top-level properties of the interface.
	if (braceDepth !== 1) {
		return { activeContainer, braceDepth, field: null };
	}
	// Reject method signatures: `name(args): ret;` has `(` before `:`.
	const colonIdx = line.indexOf(":");
	const parenIdx = line.indexOf("(");
	if (parenIdx !== -1 && (colonIdx === -1 || parenIdx < colonIdx)) {
		return { activeContainer, braceDepth, field: null };
	}

	const fieldMatch = FIELD_DECL_RE.exec(line);
	if (!fieldMatch) {
		return { activeContainer, braceDepth, field: null };
	}
	const fieldName = fieldMatch[1] ?? "";
	return {
		activeContainer,
		braceDepth,
		field: { file, line: lineIndex + 1, containerName: activeContainer, field: fieldName },
	};
}

function extractInterfaceFields(file: string): InterfaceField[] {
	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch (_) {
		return [];
	}
	const lines = content.split("\n");
	const fields: InterfaceField[] = [];
	let activeContainer: string | null = null;
	let braceDepth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const result = scanInterfaceLine(line, i, file, activeContainer, braceDepth);
		activeContainer = result.activeContainer;
		braceDepth = result.braceDepth;
		if (result.field) fields.push(result.field);
	}
	return fields;
}

const KNOWN_FALSE_POSITIVES = new Set<string>([
	// Reserved for legitimate contract fields the heuristic can't see
	// (re-exports through index files, dynamic property access, etc.).
	// Add entries here with a one-line rationale comment immediately above
	// so the next reader knows why.
]);

/**
 * Search corpus for at least one read of `fieldName` outside the declaring
 * file and its colocated test. Returns true if any such read exists.
 */
function fieldIsReadElsewhere(
	field: InterfaceField,
	allFiles: readonly string[],
	contentByFile: ReadonlyMap<string, string | null>,
): boolean {
	if (KNOWN_FALSE_POSITIVES.has(field.field)) return true;
	const escaped = field.field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const propRe = new RegExp(`\\b${escaped}\\b`);

	// Colocated test: same dir + same base name + .test/.spec suffix.
	const declBase = field.file.replace(/\.tsx?$/, "");
	for (const file of allFiles) {
		if (file === field.file) continue;
		const isColocatedTest =
			file.startsWith(declBase) && TEST_FILE_RE.test(file);
		if (isColocatedTest) continue;
		const content = contentByFile.get(file);
		if (content === undefined || content === null) continue;
		if (propRe.test(content)) return true;
	}
	return false;
}

export interface DeadInterfaceFieldOptions {
	/** Restrict declarations before the cross-file read scan begins. */
	containerFilter?: (containerName: string) => boolean;
}

export function findDeadInterfaceFields(
	targetDir: string,
	searchRoot: string,
	options: DeadInterfaceFieldOptions = {},
): DeadFieldFinding[] {
	// Walk separately so we control which directory we scan for declarations
	// vs. which corpus we scan for reads. Test files are included in the
	// search corpus (a non-colocated integration test is a real consumer).
	const declaringFiles: string[] = [];
	for (const f of walkSourceFiles(targetDir)) {
		if (!TEST_FILE_RE.test(f)) declaringFiles.push(f);
	}
	const allFiles = [...walkSourceFiles(searchRoot)];
	const contentByFile = new Map<string, string | null>();
	for (const file of allFiles) {
		try {
			contentByFile.set(file, readFileSync(file, "utf-8"));
		} catch (_) {
			contentByFile.set(file, null);
		}
	}

	const findings: DeadFieldFinding[] = [];
	for (const file of declaringFiles) {
		const fields = extractInterfaceFields(file).filter((field) =>
			options.containerFilter?.(field.containerName) ?? true);
		for (const field of fields) {
			if (!fieldIsReadElsewhere(field, allFiles, contentByFile)) {
				findings.push({
					file: relative(searchRoot, field.file),
					line: field.line,
					containerName: field.containerName,
					field: field.field,
				});
			}
		}
	}
	return findings;
}
