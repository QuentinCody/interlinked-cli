// ===========================================
// TSC Overlay — shared LanguageService construction
// ===========================================
// Extracted from tsc-overlay.ts so the SAME LanguageService-construction and
// overlay-diagnosis logic backs two call sites without duplication:
//   - the in-process fallback path (tsc-overlay.ts, mode: "in-process")
//   - the sidecar process entry (tsc-overlay-sidecar-main.ts), which runs
//     this exact code in a disposable child process so the whole-project
//     LanguageService heap (~1-2GB on this repo) never touches the daemon.
//
// See tsc-overlay.ts for the public dispatcher and mode selection.

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import type { CheckResult } from "../types.js";

type Ts = typeof import("typescript");

// -------------------------------------------
// Lazy TypeScript loader
// -------------------------------------------

const _tsCache = new Map<string, Ts | null>();
const nodeRequire = createRequire(import.meta.url);

function loadTypeScript(projectRoot: string): Ts | null {
	const cached = _tsCache.get(projectRoot);
	if (cached !== undefined) return cached;
	// Prefer the target project's own typescript so the overlay sees the
	// same compiler version the project uses for `tsc --noEmit`.
	try {
		const resolved = nodeRequire.resolve("typescript", { paths: [projectRoot] });
		const ts = nodeRequire(resolved) as Ts;
		_tsCache.set(projectRoot, ts);
		return ts;
	} catch (_err) {
		void 0; /* intentional: not in target project; try CLI's bundled typescript */
	}
	try {
		const ts = nodeRequire("typescript") as Ts;
		_tsCache.set(projectRoot, ts);
		return ts;
	} catch (_err) {
		void 0; /* intentional: typescript unavailable anywhere — overlay disabled */
	}
	_tsCache.set(projectRoot, null);
	return null;
}

// -------------------------------------------
// Per-project LanguageService cache
// -------------------------------------------

interface ServiceContext {
	ts: Ts;
	/** Mutable: null until createLanguageService completes construction below. */
	service: import("typescript").LanguageService | null;
	tsconfigDir: string;
	/** Mutable: the file being overlaid, if any. */
	overlay: { filePath: string; content: string; version: number } | null;
	/**
	 * Mutable: sibling files overlaid simultaneously (abs path -> proposed
	 * content) so cross-file resolution sees the proposed combined state of a
	 * transactional multi-file edit, not disk.
	 */
	siblings: Map<string, string>;
	/** Per-file version counter; bumped when mtime changes (for non-overlay) */
	versions: Map<string, number>;
	/** Last-seen mtime per file; drives version bumps for files touched outside the overlay */
	mtimes: Map<string, number>;
}

const _serviceCache = new Map<string, ServiceContext | null>();

function findTsconfig(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		const candidate = resolve(dir, "tsconfig.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

function getOrCreateService(projectRoot: string): ServiceContext | null {
	const cached = _serviceCache.get(projectRoot);
	if (cached !== undefined) return cached;

	const ts = loadTypeScript(projectRoot);
	if (!ts) {
		_serviceCache.set(projectRoot, null);
		return null;
	}

	const tsconfigPath = findTsconfig(projectRoot);
	if (!tsconfigPath) {
		_serviceCache.set(projectRoot, null);
		return null;
	}

	const tsconfigDir = dirname(tsconfigPath);

	const parseResult = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
	if (parseResult.error) {
		_serviceCache.set(projectRoot, null);
		return null;
	}

	const parsed = ts.parseJsonConfigFileContent(parseResult.config, ts.sys, tsconfigDir);
	if (parsed.errors.length > 0 && parsed.fileNames.length === 0) {
		_serviceCache.set(projectRoot, null);
		return null;
	}

	const ctx: ServiceContext = {
		ts,
		service: null,
		tsconfigDir,
		overlay: null,
		siblings: new Map(),
		versions: new Map(),
		mtimes: new Map(),
	};
	// Freeze the file list once at construction time. Adding files mid-session
	// requires a service rebuild (via clearOverlayServiceCache) — acceptable
	// since new files trigger a rebuild naturally on the next edit anyway.
	const staticFileNames = parsed.fileNames;
	const compilerOptions = parsed.options;

	const host: import("typescript").LanguageServiceHost = {
		getCompilationSettings: () => compilerOptions,
		getScriptFileNames: () => {
			// Include the overlaid file + any sibling overlays not already part of
			// the project (covers Write-of-new-file edits not yet on disk).
			const extra: string[] = [];
			if (ctx.overlay && !staticFileNames.includes(ctx.overlay.filePath)) {
				extra.push(ctx.overlay.filePath);
			}
			for (const p of ctx.siblings.keys()) {
				if (!staticFileNames.includes(p)) extra.push(p);
			}
			return extra.length > 0 ? [...staticFileNames, ...extra] : staticFileNames;
		},
		getScriptVersion: (fileName) => {
			if (ctx.overlay && fileName === ctx.overlay.filePath) {
				return String(ctx.overlay.version);
			}
			// Sibling overlays carry a version bumped on set/clear so the LS
			// invalidates its snapshot when the content flips disk<->proposed.
			if (ctx.siblings.has(fileName)) {
				return String(ctx.versions.get(fileName) ?? 0);
			}
			// Bump on-disk version if mtime changed since we last saw it —
			// keeps cross-file analysis accurate when files change between
			// overlay calls.
			let mtime = 0;
			try {
				mtime = statSync(fileName).mtimeMs;
			} catch (_err) {
				void 0; /* intentional: file missing — use version 0 */
			}
			const prevMtime = ctx.mtimes.get(fileName) ?? 0;
			if (mtime > prevMtime) {
				ctx.mtimes.set(fileName, mtime);
				const v = (ctx.versions.get(fileName) ?? 0) + 1;
				ctx.versions.set(fileName, v);
				return String(v);
			}
			return String(ctx.versions.get(fileName) ?? 0);
		},
		getScriptSnapshot: (fileName) => {
			if (ctx.overlay && fileName === ctx.overlay.filePath) {
				return ts.ScriptSnapshot.fromString(ctx.overlay.content);
			}
			const sibling = ctx.siblings.get(fileName);
			if (sibling !== undefined) {
				return ts.ScriptSnapshot.fromString(sibling);
			}
			if (!existsSync(fileName)) return undefined;
			const content = ts.sys.readFile(fileName);
			if (content === undefined) return undefined;
			return ts.ScriptSnapshot.fromString(content);
		},
		getCurrentDirectory: () => tsconfigDir,
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
		readFile: (p, encoding) => ts.sys.readFile(p, encoding),
		fileExists: (p) => ts.sys.fileExists(p),
		readDirectory: (p, extensions, exclude, include, depth) =>
			ts.sys.readDirectory(p, extensions, exclude, include, depth),
		directoryExists: (p) => ts.sys.directoryExists(p),
		getDirectories: (p) => ts.sys.getDirectories(p),
	};

	ctx.service = ts.createLanguageService(host, ts.createDocumentRegistry());
	_serviceCache.set(projectRoot, ctx);
	return ctx;
}

// -------------------------------------------
// Public API
// -------------------------------------------

export const OVERLAY_EXT = /\.(tsx?|mts|cts)$/;

export interface RunTscOverlayInput {
	projectRoot: string;
	filePath: string;
	content: string;
	/**
	 * Other in-flight files of a transactional multi-file edit, overlaid in
	 * memory so cross-file resolution (imports, shared types) sees the proposed
	 * combined state instead of disk. The target `filePath` always wins over a
	 * sibling of the same path.
	 */
	siblings?: ReadonlyArray<{ filePath: string; content: string }>;
}

/**
 * Run the LanguageService overlay check IN THIS PROCESS. Callers wanting
 * process isolation (the default daemon path) go through the sidecar client
 * instead; this function is what the sidecar process itself calls, and what
 * the in-process fallback mode calls directly.
 */
export function runOverlayCheckInProcess(input: RunTscOverlayInput): CheckResult[] {
	const { projectRoot, filePath, content } = input;
	if (!OVERLAY_EXT.test(filePath)) return [];

	const ctx = getOrCreateService(projectRoot);
	if (!ctx || !ctx.service) return [];
	const { ts, service } = ctx;
	const absFilePath = resolve(filePath);

	setOverlayTarget(ctx, absFilePath, content);
	const siblingPaths = setOverlaySiblings(ctx, absFilePath, input.siblings ?? []);

	try {
		const syntactic = service.getSyntacticDiagnostics(absFilePath);
		const semantic = service.getSemanticDiagnostics(absFilePath);
		const all = [...syntactic, ...semantic];
		return buildOverlayResults(ts, projectRoot, absFilePath, all);
	} catch {
		// intentional: LS internals can throw on malformed ASTs — treat as
		// "no diagnostics" rather than crashing the caller (in-process mode)
		// or the sidecar process (sidecar mode).
		return [];
	} finally {
		clearOverlayTarget(ctx, absFilePath, siblingPaths);
	}
}

/** Set the primary overlay, bumping its version so the LS invalidates caches for this file. */
function setOverlayTarget(ctx: ServiceContext, absFilePath: string, content: string): void {
	const prevVersion =
		ctx.overlay?.filePath === absFilePath
			? ctx.overlay.version
			: (ctx.versions.get(absFilePath) ?? 0);
	ctx.overlay = {
		filePath: absFilePath,
		content,
		version: prevVersion + 1,
	};
}

/**
 * Overlay sibling files (other batch members) so cross-file analysis of the
 * target sees the proposed combined state. Bumps each version so the LS
 * invalidates any cached snapshot for the flip to in-memory content. Returns
 * the absolute paths overlaid, for later cleanup.
 */
function setOverlaySiblings(
	ctx: ServiceContext,
	absFilePath: string,
	siblings: ReadonlyArray<{ filePath: string; content: string }>,
): string[] {
	const siblingPaths: string[] = [];
	for (const sib of siblings) {
		const abs = resolve(sib.filePath);
		if (abs === absFilePath) continue;
		ctx.siblings.set(abs, sib.content);
		ctx.versions.set(abs, (ctx.versions.get(abs) ?? 0) + 1);
		siblingPaths.push(abs);
	}
	return siblingPaths;
}

/**
 * Freeze the last version used for the overlaid file so subsequent non-
 * overlay reads return stable versions, clear the overlay itself so
 * cross-file calls see disk state, and drop sibling overlays (bumping their
 * versions again so the next read invalidates the in-memory snapshot back to
 * disk content).
 */
function clearOverlayTarget(
	ctx: ServiceContext,
	absFilePath: string,
	siblingPaths: readonly string[],
): void {
	// ctx.overlay is always set here — setOverlayTarget assigned it above,
	// and nothing between there and this finally block clears it.
	ctx.versions.set(absFilePath, (ctx.overlay as NonNullable<ServiceContext["overlay"]>).version);
	ctx.overlay = null;
	for (const abs of siblingPaths) {
		ctx.versions.set(abs, (ctx.versions.get(abs) ?? 0) + 1);
		ctx.siblings.delete(abs);
	}
}

/** Convert raw tsc diagnostics into the check-engine's CheckResult shape. */
function buildOverlayResults(
	ts: Ts,
	projectRoot: string,
	absFilePath: string,
	diagnostics: readonly import("typescript").Diagnostic[],
): CheckResult[] {
	const results: CheckResult[] = [];
	for (const d of diagnostics) {
		const severity = diagnosticSeverity(ts, d);
		if (severity === null) continue;

		let file = absFilePath;
		let line = 0;
		let column: number | undefined;
		if (d.file && d.start !== undefined) {
			file = d.file.fileName;
			const pos = d.file.getLineAndCharacterOfPosition(d.start);
			line = pos.line + 1;
			column = pos.character + 1;
		}

		const relFile = relative(projectRoot, file);
		const message =
			typeof d.messageText === "string"
				? d.messageText
				: ts.flattenDiagnosticMessageText(d.messageText, "\n");

		results.push({
			tool: "tsc",
			severity,
			file: relFile,
			line,
			column,
			message,
			ruleId: `TS${d.code}`,
		});
	}
	return results;
}

function diagnosticSeverity(
	ts: Ts,
	d: import("typescript").Diagnostic,
): "error" | "warning" | null {
	if (d.category === ts.DiagnosticCategory.Error) return "error";
	if (d.category === ts.DiagnosticCategory.Warning) return "warning";
	return null;
}

/**
 * Drop the cached LanguageService for a project (or all projects). Call when
 * tsconfig.json changes or files are added/removed, or (daemon path) to shed
 * the retained heap under idle/RSS pressure.
 */
export function clearOverlayServiceCache(projectRoot?: string): void {
	if (projectRoot) {
		_serviceCache.delete(projectRoot);
	} else {
		_serviceCache.clear();
		_tsCache.clear();
	}
}
