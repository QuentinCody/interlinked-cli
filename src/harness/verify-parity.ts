// ===========================================
// Verify Parity — static equivalents of PostToolUse structural/behavioral checks.
// ===========================================
// Closes the parity gap so `interlinked verify` surfaces every finding a
// coding agent would see live. Specifically:
//   - Cross-file switch discriminant (aggregated over the whole project)
//   - Single-implementation interface (aggregated over the whole project)
//   - Files without corresponding test (static version of prod-delta-no-test)
//   - Project-wide prod/test LOC ratio (static version of checkProdTestLocRatio)
//
// Aggregators scan each file once, unlike the per-file PostToolUse versions
// that re-scan the project per edit.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { isGeneratedFile } from "./checks/shared.js";
import type { StructuralCheckResult } from "./types.js";

const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;
const JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

const SWITCH_DISC = /\bswitch\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\)/g;
const DISC_TAIL = /\.(kind|type|tag|variant|_tag)$/;

const IFACE_DECL = /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g;
const IMPL_EXTENDS = /\b(?:implements|extends)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/g;

const PROD_TEST_LOC_RATIO_LIMIT = 5;

interface FileContent {
	file: string;
	content: string;
	lineCount: number;
	isTest: boolean;
}

function safeReadAll(files: string[]): FileContent[] {
	const out: FileContent[] = [];
	for (const file of files) {
		const ext = extname(file);
		if (!JS_TS_EXTS.has(ext)) continue;
		let content: string;
		try {
			content = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		out.push({
			file,
			content,
			lineCount: content.split("\n").length,
			isTest: TEST_FILE_RE.test(file),
		});
	}
	return out;
}

function lineOfOffset(content: string, offset: number): number {
	return content.slice(0, offset).split("\n").length;
}

/**
 * Scan every file once, group `switch (x.kind)` hits by discriminant, emit a
 * finding per call-site when the same discriminant appears in ≥2 files.
 */
export function scanProjectSwitchDiscriminants(reads: FileContent[]): StructuralCheckResult[] {
	const usesByDisc = new Map<string, Array<{ file: string; line: number }>>();

	for (const { file, content, isTest } of reads) {
		// Skip test files — their fixture content frequently contains switches
		// that are not production code.
		if (isTest) continue;
		for (const m of content.matchAll(SWITCH_DISC)) {
			const disc = nonNull(m[1]);
			if (!DISC_TAIL.test(disc)) continue;
			const line = lineOfOffset(content, m.index);
			const arr = usesByDisc.get(disc) ?? [];
			arr.push({ file, line });
			usesByDisc.set(disc, arr);
		}
	}

	const results: StructuralCheckResult[] = [];
	for (const [disc, uses] of usesByDisc) {
		const fileCount = new Set(uses.map((u) => u.file)).size;
		if (fileCount < 2) continue;
		for (const u of uses) {
			const others = uses.filter((o) => o.file !== u.file).map((o) => o.file);
			results.push({
				check: "cross_file_switch_discriminant",
				severity: "warning",
				file: u.file,
				message: `switches on \`${disc}\` (line ${u.line}) — also seen in ${fileCount - 1} other file(s). Consider polymorphic dispatch.`,
				affectedFiles: [...new Set(others)],
			});
		}
	}
	return results;
}

interface IfaceInfo {
	file: string;
	name: string;
	line: number;
}

/** Collect every `export interface X` declaration in the non-test files. */
function collectExportedInterfaces(reads: FileContent[]): IfaceInfo[] {
	const interfaces: IfaceInfo[] = [];
	for (const { file, content, isTest } of reads) {
		if (isTest) continue;
		for (const m of content.matchAll(IFACE_DECL)) {
			interfaces.push({
				file,
				name: nonNull(m[1]),
				line: lineOfOffset(content, m.index),
			});
		}
	}
	return interfaces;
}

/** Pre-index `implements`/`extends` occurrences: implemented name → files naming it. */
function indexImplementorsByName(reads: FileContent[]): Map<string, Set<string>> {
	const implsByName = new Map<string, Set<string>>();
	for (const { file, content, isTest } of reads) {
		if (isTest) continue;
		for (const m of content.matchAll(IMPL_EXTENDS)) {
			const names = nonNull(m[1])
				.split(",")
				.map((n) => n.trim());
			for (const name of names) {
				const set = implsByName.get(name) ?? new Set<string>();
				set.add(file);
				implsByName.set(name, set);
			}
		}
	}
	return implsByName;
}

/**
 * Scan every file once for `export interface X`, count implementors across
 * other files, flag interfaces with exactly one implementor.
 */
export function scanProjectSingleImplInterfaces(reads: FileContent[]): StructuralCheckResult[] {
	const interfaces = collectExportedInterfaces(reads);
	if (interfaces.length === 0) return [];

	const implsByName = indexImplementorsByName(reads);

	const results: StructuralCheckResult[] = [];
	for (const iface of interfaces) {
		const impls = implsByName.get(iface.name);
		if (!impls) continue;
		const others = [...impls].filter((f) => f !== iface.file);
		if (others.length !== 1) continue;
		results.push({
			check: "single_implementation_interface",
			severity: "info",
			file: iface.file,
			message: `Interface \`${iface.name}\` (line ${iface.line}) has exactly one implementor: ${basename(nonNull(others[0]))}. Premature abstraction?`,
			affectedFiles: others,
		});
	}
	return results;
}

/**
 * Find production files with no conventional test file on disk.
 * Static equivalent of checkProdDeltaWithoutTestDelta.
 */
export function scanFilesWithoutTest(
	reads: FileContent[],
): Array<{ file: string; expectedTest: string }> {
	const out: Array<{ file: string; expectedTest: string }> = [];
	for (const { file, isTest, content } of reads) {
		if (isTest) continue;
		// Generated files (OpenAPI codegen, protoc, etc.) don't have unit-test
		// siblings by design — flagging them produces 67 FPs in one Supermodel
		// sdk repo (139-repo audit, 2026-05).
		if (isGeneratedFile(content)) continue;
		const ext = extname(file);
		const base = file.slice(0, -ext.length);
		const dir = dirname(file);
		const baseName = basename(file, ext);
		const candidates = [
			`${base}.test${ext}`,
			`${base}.spec${ext}`,
			join(dir, "__tests__", `${baseName}.test${ext}`),
			join(dir, "__tests__", `${baseName}.spec${ext}`),
		];
		if (candidates.some((p) => existsSync(p))) continue;
		out.push({ file, expectedTest: `${base}.test${ext}` });
	}
	return out;
}

/**
 * Project-wide prod/test LOC ratio. Static equivalent of checkProdTestLocRatio.
 * Returns null if no files were scanned.
 */
interface ProjectLocRatio {
	prodLoc: number;
	testLoc: number;
	ratio: number;
	exceeded: boolean;
	limit: number;
}

export function computeProjectLocRatio(reads: FileContent[]): ProjectLocRatio | null {
	let prodLoc = 0;
	let testLoc = 0;
	for (const r of reads) {
		if (r.isTest) testLoc += r.lineCount;
		else prodLoc += r.lineCount;
	}
	if (prodLoc === 0 && testLoc === 0) return null;
	const ratio = testLoc === 0 ? Number.POSITIVE_INFINITY : prodLoc / testLoc;
	return {
		prodLoc,
		testLoc,
		ratio,
		exceeded: ratio > PROD_TEST_LOC_RATIO_LIMIT,
		limit: PROD_TEST_LOC_RATIO_LIMIT,
	};
}

interface VerifyParityResults {
	crossFileSwitchDiscriminant: StructuralCheckResult[];
	singleImplementationInterface: StructuralCheckResult[];
	filesWithoutTest: Array<{ file: string; expectedTest: string }>;
	projectLocRatio: ProjectLocRatio | null;
}

/**
 * Run all verify-parity checks over the given file list. Reads each file once.
 */
export function runVerifyParityChecks(files: string[]): VerifyParityResults {
	const reads = safeReadAll(files);
	return {
		crossFileSwitchDiscriminant: scanProjectSwitchDiscriminants(reads),
		singleImplementationInterface: scanProjectSingleImplInterfaces(reads),
		filesWithoutTest: scanFilesWithoutTest(reads),
		projectLocRatio: computeProjectLocRatio(reads),
	};
}
