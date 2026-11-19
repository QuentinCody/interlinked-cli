// Check Evidence Contract — corpus "detector identity" as the detector's own
// static import closure.
//
// A corpus record says "this detector code, over these inputs, gave these
// hits". Until 2026-11-05 the detector half was one digest over every non-test
// file under src/. Any byte change to any of those ~2300 files during the 20 s
// pin voided the cohort's evidence, so concurrent agents editing unrelated
// files turned the pin red (scratch/instruction-files/check-evidence-eval.md §1).
//
// Now one capture at load time records the digest of each source file and the
// files that export each name. A detector's identity is the digest of the files
// its exporting module reaches through static runtime imports (parsed by
// `kill-proof/bound-imports.ts staticLocalSpecifiers`, resolved against the
// captured file set), plus the lockfile and the Node version. `current` reads
// exactly those files again. A closure file that differs from the load-time
// capture means the loaded code is no longer described by the bytes on disk.
// An edit to a file outside the closure changes nothing.
//
// Not bound by bytes (limits): dynamic `import()` / `require()`, bare
// specifiers (packages are bound through the lockfile), type-only imports
// (erased at runtime), and a relative specifier that resolves to no captured
// source file (JSON, `.d.ts`, a test file). The last kind is recorded by its
// specifier, so adding or removing such an import still changes the identity.
// A detector whose function name no captured source file exports (an inline
// registry arrow, a test-local function) is `unavailable`: what cannot be
// located cannot be bound, so its corpus evidence never qualifies.

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { evidenceDigest } from "../finding-outcomes.js";
import { staticLocalSpecifiers } from "../kill-proof/bound-imports.js";
import { captureCorpusInputs } from "./corpus-snapshot.js";
import { exportedNames } from "./resolve.js";

/** The identity of a detector as loaded, and as its closure reads on disk now. */
export interface DetectorIdentity {
	loaded: string;
	current: string;
}

/** Look up the identity of one detector by its function name. */
export type DetectorIdentitySource = (detectorFn: string) => DetectorIdentity;

/** A closure larger than this is not bound (it would certify less than it loads). */
export const MAX_DETECTOR_CLOSURE = 400;

const UNAVAILABLE: DetectorIdentity = { loaded: "unavailable", current: "unavailable" };
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

interface LoadedSources {
	root: string;
	/** Repo-relative path (posix) → content digest at load time. */
	digests: ReadonlyMap<string, string>;
	/** Exported name → repo-relative files that export it. */
	exporters: ReadonlyMap<string, readonly string[]>;
	/** Digest of the dependency manifest at load time. */
	lock: string;
}

interface ClosureWalk {
	files: string[];
	unresolved: string[];
	/** Repo-relative path → content digest read now. */
	current: Map<string, string>;
	truncated: boolean;
}

function toPosix(path: string): string {
	return path.replace(/\\/g, "/");
}

function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function lockDigest(root: string): string {
	const name = existsSync(join(root, "package-lock.json")) ? "package-lock.json" : "package.json";
	const text = readOrNull(join(root, name));
	return text === null ? "unreadable" : evidenceDigest(text);
}

/** Resolve a relative specifier against the captured file set only (no disk probe). */
export function resolveInFileSet(fromFile: string, specifier: string, files: ReadonlySet<string>): string | null {
	const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
	const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
	const candidates = [
		base,
		...RESOLVE_EXTENSIONS.map((ext) => stem + ext),
		...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
	];
	return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/** Add one file's resolved imports to the walk; false when the cap is hit. */
function enqueueImports(file: string, content: string, files: ReadonlySet<string>, walk: ClosureWalk, queue: string[]): boolean {
	for (const specifier of staticLocalSpecifiers(content, file)) {
		const target = resolveInFileSet(file, specifier, files);
		if (target === null) {
			walk.unresolved.push(`${file} -> ${specifier}`);
			continue;
		}
		if (walk.current.has(target) || queue.includes(target)) continue;
		if (walk.files.length + queue.length >= MAX_DETECTOR_CLOSURE) return false;
		queue.push(target);
	}
	return true;
}

/** Breadth-first walk of the static runtime import closure, reading current bytes. */
function walkClosure(sources: LoadedSources, roots: readonly string[]): ClosureWalk {
	const files = new Set(sources.digests.keys());
	const walk: ClosureWalk = { files: [], unresolved: [], current: new Map(), truncated: false };
	const queue = [...roots];
	while (queue.length > 0) {
		const file = queue.shift() as string;
		const content = readOrNull(join(sources.root, file));
		walk.files.push(file);
		walk.current.set(file, content === null ? "unreadable" : evidenceDigest(content));
		if (content === null) continue;
		if (!enqueueImports(file, content, files, walk, queue)) {
			walk.truncated = true;
			break;
		}
	}
	return walk;
}

function identityDigest(walk: ClosureWalk, digestOf: (file: string) => string, lock: string): string {
	const entries = [...walk.files].sort().map((file) => [file, digestOf(file)]);
	return evidenceDigest(JSON.stringify(["detector-closure.v1", entries, [...walk.unresolved].sort(), lock, process.version]));
}

/** Identity of one detector against the load-time capture. */
function identityFor(sources: LoadedSources, detectorFn: string): DetectorIdentity {
	const roots = sources.exporters.get(detectorFn) ?? [];
	if (roots.length === 0) return UNAVAILABLE;
	const walk = walkClosure(sources, roots);
	if (walk.truncated) return UNAVAILABLE;
	return {
		loaded: identityDigest(walk, (file) => sources.digests.get(file) ?? "absent-at-load", sources.lock),
		current: identityDigest(walk, (file) => walk.current.get(file) ?? "unreadable", lockDigest(sources.root)),
	};
}

/** Index every exported name of the captured non-test sources. */
function indexExporters(inputs: readonly { file: string; content: string }[]): Map<string, string[]> {
	const exporters = new Map<string, string[]>();
	for (const input of inputs) {
		for (const name of exportedNames(input.content)) {
			const list = exporters.get(name);
			if (list) list.push(toPosix(input.file));
			else exporters.set(name, [toPosix(input.file)]);
		}
	}
	return exporters;
}

/**
 * Capture the non-test sources under `<runtimeRoot>/src` once, now, and return
 * the identity lookup bound to that capture. A failed capture makes every
 * identity unavailable: a partial capture cannot describe the loaded code.
 */
export function captureDetectorSources(runtimeRoot: string): DetectorIdentitySource {
	try {
		const snapshot = captureCorpusInputs(join(runtimeRoot, "src"), runtimeRoot, "source");
		if (snapshot.failures.length > 0 || snapshot.inputs.length === 0) return () => UNAVAILABLE;
		const sources: LoadedSources = {
			root: runtimeRoot,
			digests: new Map(snapshot.inputs.map((input) => [toPosix(input.file), input.digest])),
			exporters: indexExporters(snapshot.inputs),
			lock: lockDigest(runtimeRoot),
		};
		return (detectorFn) => identityFor(sources, detectorFn);
	} catch {
		return () => UNAVAILABLE;
	}
}
