import { posix } from "node:path";
import { sourceLanguage } from "./inventory-roles.js";

/**
 * Structural uniformity of a directory, measured without a model: how alike the top-level shapes of its code files are. The numbers come
 * from a lexical pass (no parser) over column-0 lines: a file's SHAPE is the run-collapsed sequence of its top-level kinds (decorator,
 * definition, other statement; imports and `if`/`try` blocks are ignored, so conditional imports do not split shapes), its DEFINITION COUNT is
 * the number of top-level definitions, and the IDENTIFIER RATIO is distinct identifiers over all identifiers of the sampled files.
 * A directory (counted with everything below it) with at least `UNIFORM_MIN_FILES` code files, at least 97 % of them in the three most common
 * shapes, at least 80 % with the same non-zero definition count, and an identifier ratio of at most 0.07 is a CANDIDATE for generated output.
 * It is not proof: a directory of hand-written icon components or Rails policies has the same numbers. Alone it gives no role; with a second
 * kind of evidence it does (see `role-repo-evidence.ts`).
 */
export const UNIFORM_MIN_FILES = 20;
const UNIFORM_MIN_TOP3 = 0.97;
const UNIFORM_MIN_SAME_COUNT = 0.8;
const UNIFORM_MAX_IDENTIFIER_RATIO = 0.07;
const SAMPLE_FILES = 60;
const MAX_FILE_BYTES = 300_000;

/** `dir` is the directory named in reports; `root` is the outermost directory with the same measured set (what a descendant check skips). */
export interface UniformDirectory { dir: string; root: string; files: number; top3: number; sameCount: number; identifierRatio: number; detail: string; }

interface FileShape { shape: string; definitions: number; identifiers: Set<string>; tokens: number; }

const IGNORED = /^(?:import|from|use|package|#include|if|else|elif|try|except|finally|for|while|with|return|\}|\)|\]|end|#|\/\/|\/\*|\*|"""|''')/;
const DEFINITION = /^(?:class\b|def\b|async\s+def\b|function\b|async\s+function\b|func\b|fn\b|struct\b|enum\b|interface\b|type\s+\w+\s+struct\b|message\b|export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\b|pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\b|(?:public|final|abstract)\s+(?:final\s+|abstract\s+)?(?:class|interface|enum)\b)/;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** The kind of one column-0 line, or null for a line that does not shape a file (indented, blank, import, conditional, comment). */
function kindOf(line: string): { kind: string; isDefinition: boolean } | null {
	if (line === "" || /^\s/.test(line) || IGNORED.test(line)) return null;
	if (line.startsWith("@") || line.startsWith("#[")) return { kind: "@", isDefinition: false };
	if (DEFINITION.test(line)) return { kind: "def", isDefinition: true };
	return /^[A-Za-z_]/.test(line) ? { kind: "stmt", isDefinition: false } : null;
}

function shapeOf(content: string): FileShape {
	const kinds: string[] = [], identifiers = new Set<string>();
	let definitions = 0, tokens = 0;
	for (const line of content.split("\n")) {
		const found = kindOf(line);
		if (found === null) continue;
		if (found.isDefinition) definitions++;
		if (kinds.at(-1) !== found.kind) kinds.push(found.kind);
	}
	for (const found of content.matchAll(IDENTIFIER)) { tokens++; identifiers.add(found[0]); }
	return { shape: kinds.join(">"), definitions, identifiers, tokens };
}

function sample<T>(items: readonly T[]): T[] {
	if (items.length <= SAMPLE_FILES) return [...items];
	return Array.from({ length: SAMPLE_FILES }, (_, i) => items[Math.floor((i * items.length) / SAMPLE_FILES)] as T);
}

interface Measured { top3: number; sameCount: number; identifierRatio: number; }

const topShare = (counts: ReadonlyMap<unknown, number>, take: number, total: number): number =>
	total === 0 ? 0 : [...counts.values()].sort((a, b) => b - a).slice(0, take).reduce((sum, count) => sum + count, 0) / total;

/** The three measures of a set of files whose contents are in hand (also used to report numbers for a directory that does not pass). */
export function measureFiles(contents: readonly string[]): Measured { return measure(contents.map(shapeOf)); }

function measure(shapes: readonly FileShape[]): Measured {
	const shapeCounts = new Map<string, number>(), definitionCounts = new Map<number, number>(), vocabulary = new Set<string>();
	let tokens = 0;
	for (const shape of shapes) {
		shapeCounts.set(shape.shape, (shapeCounts.get(shape.shape) ?? 0) + 1);
		definitionCounts.set(shape.definitions, (definitionCounts.get(shape.definitions) ?? 0) + 1);
		tokens += shape.tokens;
		for (const word of shape.identifiers) vocabulary.add(word);
	}
	// A set of files that hold no definition at all (statements, data tables, test suites) is not a set of generated modules.
	const modal = [...definitionCounts].sort((a, b) => b[1] - a[1])[0];
	const sameCount = modal === undefined || modal[0] === 0 ? 0 : modal[1] / shapes.length;
	return { top3: topShare(shapeCounts, 3, shapes.length), sameCount, identifierRatio: tokens === 0 ? 1 : vocabulary.size / tokens };
}

const passes = (m: Measured): boolean => m.top3 >= UNIFORM_MIN_TOP3 && m.sameCount >= UNIFORM_MIN_SAME_COUNT && m.identifierRatio <= UNIFORM_MAX_IDENTIFIER_RATIO;

/** Every directory with code files below it, mapped to those files. */
function filesByDirectory(paths: readonly string[]): Map<string, string[]> {
	const byDirectory = new Map<string, string[]>();
	for (const path of [...paths].sort()) {
		if (sourceLanguage(path) === null) continue;
		for (let dir = posix.dirname(path); dir !== "." && dir !== ""; dir = posix.dirname(dir)) byDirectory.set(dir, [...byDirectory.get(dir) ?? [], path]);
	}
	return byDirectory;
}

/** A directory that holds all its files in one subdirectory is named by that subdirectory: the evidence points at the files, not at a wrapper. */
function deepestWithSameFiles(dir: string, count: number, byDirectory: ReadonlyMap<string, readonly string[]>): string {
	let deepest = dir;
	for (const [other, files] of byDirectory) if (files.length === count && other.startsWith(`${dir}/`) && other.length > deepest.length) deepest = other;
	return deepest;
}

export function findUniformDirectories(paths: readonly string[], read: (path: string) => string | null): UniformDirectory[] {
	const cache = new Map<string, FileShape | null>(), found: UniformDirectory[] = [];
	const shapeFor = (path: string): FileShape | null => {
		if (!cache.has(path)) {
			const content = read(path);
			cache.set(path, content === null || content.length > MAX_FILE_BYTES ? null : shapeOf(content));
		}
		return cache.get(path) ?? null;
	};
	const byDirectory = filesByDirectory(paths);
	const candidates = [...byDirectory].filter(([, files]) => files.length >= UNIFORM_MIN_FILES).sort((a, b) => a[0].split("/").length - b[0].split("/").length || a[0].localeCompare(b[0]));
	for (const [dir, files] of candidates) {
		if (found.some((above) => dir.startsWith(`${above.root}/`) || dir === above.root)) continue;
		const shapes = sample(files).map(shapeFor).filter((shape): shape is FileShape => shape !== null);
		if (shapes.length < UNIFORM_MIN_FILES) continue;
		const m = measure(shapes);
		if (!passes(m)) continue;
		found.push({ dir: deepestWithSameFiles(dir, files.length, byDirectory), root: dir, files: files.length, ...m,
			detail: `${files.length} files, top-3 shape share ${m.top3.toFixed(2)}, same definition count ${m.sameCount.toFixed(2)}, distinct-identifier ratio ${m.identifierRatio.toFixed(3)}` });
	}
	return found;
}
