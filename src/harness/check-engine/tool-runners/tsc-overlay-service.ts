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

import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { configFingerprintOf, selectCheckerConfig } from "../../config-graph.js";
import type { CheckResult } from "../types.js";
import { type DiskRead, type DiskReader, diskVersion, readOnce } from "./tsc-overlay-identity.js";

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
		// SAFETY: createRequire loads the installed TypeScript package selected by Node resolution; its exported compiler API matches the imported declarations.
		const ts = nodeRequire(resolved) as Ts;
		_tsCache.set(projectRoot, ts);
		return ts;
	} catch (_err) {
		void 0; /* intentional: not in target project; try CLI's bundled typescript */
	}
	try {
		// SAFETY: createRequire loads the installed TypeScript package selected by Node resolution; its exported compiler API matches the imported declarations.
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
	/** The project root the caller named; `clearOverlayServiceCache(projectRoot)` drops by it. */
	projectRoot: string;
	/** The configuration this service was built from — every file of the
	 *  config's `extends` closure by content. A lookup whose fingerprint
	 *  differs rebuilds the service: the host closes over the options parsed
	 *  at construction (review r7, finding 2). */
	configFingerprint: string;
	tsconfigPath: string;
	tsconfigDir: string;
	/** Mutable: the project's root files, re-enumerated from the config on
	 *  every reuse so a declaration or source file added or removed on disk
	 *  joins or leaves the program (review r8, finding 1). */
	rootFileNames: string[];
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
	/** Last-seen CONTENT identity per root file; any change bumps the version.
	 *  Content, not metadata: a write through a shared memory mapping changes
	 *  bytes before any timestamp moves (review r10, finding 1), so mtime,
	 *  ctime and size are not identity. */
	identities: Map<string, string>;
	/** The current run's reads (one per file per run) — the version's
	 *  identity and the snapshot come from the same read (review r11);
	 *  cleared when a run starts and again when it ends. */
	runReads: Map<string, DiskRead>;
}

/** One LanguageService per GOVERNING tsconfig (keyed by its path), not per project root. */
const _serviceCache = new Map<string, ServiceContext>();

type ServiceLookup =
	| { kind: "service"; ctx: ServiceContext }
	/** No single project claims the file: the compiler does not guess (review r6, finding 2). */
	| { kind: "not_measured"; reason: string }
	/** No tsconfig in reach, or no `typescript` — the overlay does not apply. */
	| { kind: "none" };

/**
 * The service for the project that GOVERNS `filePath` — selected the way
 * `self_import` selects it (nearest config, `references`, sibling
 * `tsconfig*.json` files, membership by the config's own patterns; see
 * `selectCheckerConfig`), so the compiler phase and the self-import rail judge
 * one program. A file no single project claims is NOT MEASURED, never forced
 * into the project root's program (session review r6, finding 2).
 */
function getOrCreateService(projectRoot: string, filePath: string): ServiceLookup {
	const ts = loadTypeScript(projectRoot);
	if (!ts) return { kind: "none" };
	const selection = selectCheckerConfig(ts, filePath, projectRoot);
	if (selection.kind === "none") return { kind: "none" };
	if (selection.kind === "not_measured") {
		return { kind: "not_measured", reason: `${selection.reason}: ${selection.detail}` };
	}
	const fingerprint = configFingerprintOf(ts, selection.configPath);
	const cached = _serviceCache.get(selection.configPath);
	if (cached !== undefined && cached.configFingerprint === fingerprint) {
		refreshRootFiles(cached);
		return { kind: "service", ctx: cached };
	}
	const ctx = buildService(ts, projectRoot, selection.configPath, fingerprint);
	if (ctx === null) {
		return { kind: "not_measured", reason: `config_unusable: ${selection.configPath} could not be read as a program` };
	}
	_serviceCache.set(selection.configPath, ctx);
	return { kind: "service", ctx };
}

/** A project with NO source on disk yet is a valid program with no inputs: the
 *  host adds the overlaid target as a root, so the FIRST proposed source is
 *  still measured (review r7, finding 1). Null only when the config cannot be read. */
function buildService(ts: Ts, projectRoot: string, tsconfigPath: string, configFingerprint: string): ServiceContext | null {
	const tsconfigDir = dirname(tsconfigPath);
	const parseResult = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
	if (parseResult.error) return null;
	const parsed = ts.parseJsonConfigFileContent(parseResult.config, ts.sys, tsconfigDir);

	const ctx: ServiceContext = {
		ts,
		service: null,
		projectRoot,
		configFingerprint,
		tsconfigPath,
		tsconfigDir,
		rootFileNames: parsed.fileNames,
		overlay: null,
		siblings: new Map(),
		versions: new Map(),
		identities: new Map(),
		runReads: new Map(),
	};
	const host = buildLanguageServiceHost(ctx, ts, tsconfigDir, parsed.options);

	ctx.service = ts.createLanguageService(host, ts.createDocumentRegistry());
	return ctx;
}

/** Re-enumerate the project's root files from its config, so a declaration or
 *  source file added or removed on disk since the service was built joins or
 *  leaves the program on the next check (review r8, finding 1). The options
 *  themselves are covered by the fingerprint: a config change rebuilds. */
function refreshRootFiles(ctx: ServiceContext): void {
	const { ts } = ctx;
	const read = ts.readConfigFile(ctx.tsconfigPath, (p) => ts.sys.readFile(p));
	if (read.error) return;
	ctx.rootFileNames = ts.parseJsonConfigFileContent(read.config, ts.sys, ctx.tsconfigDir).fileNames;
}

// Module RESOLUTION goes through readFile / fileExists / directoryExists, not
// through getScriptSnapshot — so a sibling the batch CREATES (not yet on disk)
// must exist for these three too, or `./widget.js` under `moduleSuffixes`
// resolves past the proposed `widget.native.ts` back to the importer and
// reports a circular alias the materialized batch never has (session review
// r4, finding 1). The overlay target is treated the same way, so a batch that
// creates BOTH files judges the tree it is about to produce.

function overlayContentOf(ctx: ServiceContext, p: string): string | undefined {
	const abs = resolve(p);
	if (ctx.overlay && abs === ctx.overlay.filePath) return ctx.overlay.content;
	return ctx.siblings.get(abs);
}

function overlayReadFile(ctx: ServiceContext, ts: Ts, p: string, encoding?: string): string | undefined {
	return overlayContentOf(ctx, p) ?? ts.sys.readFile(p, encoding);
}

function overlayFileExists(ctx: ServiceContext, ts: Ts, p: string): boolean {
	return overlayContentOf(ctx, p) !== undefined || ts.sys.fileExists(p);
}

/** A directory exists when the disk has it OR an overlaid file lives beneath it. */
function overlayDirectoryExists(ctx: ServiceContext, ts: Ts, p: string): boolean {
	if (ts.sys.directoryExists(p)) return true;
	const prefix = `${resolve(p)}/`;
	if (ctx.overlay && ctx.overlay.filePath.startsWith(prefix)) return true;
	for (const sibling of ctx.siblings.keys()) {
		if (sibling.startsWith(prefix)) return true;
	}
	return false;
}

/** LanguageServiceHost.getScriptFileNames — kept out of the object literal
 *  below purely to keep buildLanguageServiceHost's own body under the
 *  function-token cap; the project's current root files (`ctx.rootFileNames`,
 *  refreshed on reuse) plus overlaid target/siblings not already part of it. */
function hostGetScriptFileNames(ctx: ServiceContext): string[] {
	const roots = ctx.rootFileNames;
	const extra: string[] = [];
	if (ctx.overlay && !roots.includes(ctx.overlay.filePath)) {
		extra.push(ctx.overlay.filePath);
	}
	for (const p of ctx.siblings.keys()) {
		if (!roots.includes(p)) extra.push(p);
	}
	return extra.length > 0 ? [...roots, ...extra] : roots;
}

/** Builds the LanguageServiceHost wired to `ctx`'s mutable overlay/version
 *  state. Extracted verbatim from getOrCreateService (unchanged behavior) so
 *  the host object — including its `readDirectory` hook above — is directly
 *  callable and testable in isolation. */
export function buildLanguageServiceHost(
	ctx: ServiceContext,
	ts: Ts,
	tsconfigDir: string,
	compilerOptions: import("typescript").CompilerOptions,
): import("typescript").LanguageServiceHost {
	const readDisk: DiskReader = (fileName) => ts.sys.readFile(fileName);
	return {
		getCompilationSettings: () => compilerOptions,
		getScriptFileNames: () => hostGetScriptFileNames(ctx),
		getScriptVersion: (fileName) => {
			if (ctx.overlay && fileName === ctx.overlay.filePath) {
				return String(ctx.overlay.version);
			}
			// Sibling overlays carry a version bumped on set/clear so the LS
			// invalidates its snapshot when the content flips disk<->proposed.
			if (ctx.siblings.has(fileName)) {
				return String(ctx.versions.get(fileName) ?? 0);
			}
			// Bump the on-disk version whenever the file's CONTENT changed since
			// we last saw it — keeps cross-file analysis accurate when files
			// change between overlay calls, whatever their timestamps say
			// (cost measured on this repository in D43). The snapshot below
			// comes from the SAME read (D44).
			return diskVersion(ctx, fileName, readDisk);
		},
		getScriptSnapshot: (fileName) => {
			if (ctx.overlay && fileName === ctx.overlay.filePath) {
				return ts.ScriptSnapshot.fromString(ctx.overlay.content);
			}
			const sibling = ctx.siblings.get(fileName);
			if (sibling !== undefined) {
				return ts.ScriptSnapshot.fromString(sibling);
			}
			const { content } = readOnce(ctx, fileName, readDisk);
			if (content === undefined) return undefined;
			return ts.ScriptSnapshot.fromString(content);
		},
		getCurrentDirectory: () => tsconfigDir,
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
		readFile: (p, encoding) => overlayReadFile(ctx, ts, p, encoding),
		fileExists: (p) => overlayFileExists(ctx, ts, p),
		readDirectory: (p, extensions, exclude, include, depth) =>
			ts.sys.readDirectory(p, extensions, exclude, include, depth),
		directoryExists: (p) => overlayDirectoryExists(ctx, ts, p),
		getDirectories: (p) => ts.sys.getDirectories(p),
	};
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

/** One in-process overlay run: findings, or the reason the compiler could not
 *  measure this file at all (no single project claims it). */
export type OverlayRun =
	| { status: "ok"; findings: CheckResult[] }
	| { status: "not_measured"; reason: string };

/**
 * Run the LanguageService overlay check IN THIS PROCESS. Callers wanting
 * process isolation (the default daemon path) go through the sidecar client
 * instead; this function is what the sidecar process itself calls, and what
 * the in-process fallback mode calls directly.
 */
export function runOverlayCheckInProcessTyped(input: RunTscOverlayInput): OverlayRun {
	const { projectRoot, filePath } = input;
	if (!OVERLAY_EXT.test(filePath)) return { status: "ok", findings: [] };

	const lookup = getOrCreateService(projectRoot, filePath);
	if (lookup.kind === "not_measured") return { status: "not_measured", reason: lookup.reason };
	if (lookup.kind === "none") return { status: "ok", findings: [] };
	const ctx = lookup.ctx;
	const service = ctx.service;
	if (service === null) return { status: "ok", findings: [] };
	const { ts } = ctx;
	return { status: "ok", findings: overlayDiagnostics(ctx, ts, service, input) };
}

/** Legacy findings-only shape: NOT MEASURED collapses to `[]`. */
export function runOverlayCheckInProcess(input: RunTscOverlayInput): CheckResult[] {
	const run = runOverlayCheckInProcessTyped(input);
	return run.status === "ok" ? run.findings : [];
}

function overlayDiagnostics(
	ctx: ServiceContext,
	ts: Ts,
	service: import("typescript").LanguageService,
	input: RunTscOverlayInput,
): CheckResult[] {
	const { projectRoot, filePath, content } = input;
	const absFilePath = resolve(filePath);

	ctx.runReads.clear();
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
		ctx.runReads.clear(); // the run's copies of every program text are not retained
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
 * Move the overlaid file's version PAST the overlay's so the next non-overlay
 * read invalidates the in-memory snapshot back to disk content, clear the
 * overlay itself so cross-file calls see disk state, and drop sibling
 * overlays (bumping their versions again for the same reason).
 */
function clearOverlayTarget(
	ctx: ServiceContext,
	absFilePath: string,
	siblingPaths: readonly string[],
): void {
	// The version moves PAST the overlay's, so the next non-overlay read
	// invalidates the LanguageService's snapshot back to the disk content: a
	// proposal that never reached disk must not stay the file's content for
	// later checks (session review r9, finding 1).
	// SAFETY: ctx.overlay is always set here — setOverlayTarget assigned it
	// above, and nothing between there and this finally block clears it.
	ctx.versions.set(absFilePath, (ctx.overlay as NonNullable<ServiceContext["overlay"]>).version + 1);
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

export function diagnosticSeverity(
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
		dropServicesUnder(projectRoot);
	} else {
		_serviceCache.clear();
		_tsCache.clear();
	}
}

/** Services are keyed by their governing config; a project root may own several. */
function dropServicesUnder(projectRoot: string): void {
	for (const [configPath, ctx] of _serviceCache) {
		if (ctx.projectRoot === projectRoot) _serviceCache.delete(configPath);
	}
}
