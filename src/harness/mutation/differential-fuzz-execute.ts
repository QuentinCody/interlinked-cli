// ===========================================
// Differential fuzz — module loading, call observation, output comparison
// ===========================================
// The mechanics under the search loop:
//   - `rewriteImports` / `loadModulePair`: the pristine and the mutated module are
//     written to a private temp dir under distinct names and `import()`ed. Relative
//     specifiers are rewritten to absolute paths first, so both copies resolve the
//     SAME dependency modules as the original file (and share their state).
//   - `summarizeCall`: one observed call. A synchronous infinite loop (a classic
//     mutant outcome: `i++` → `i--`) is cut off by `vm`'s script timeout rather than
//     hanging the process; it is recorded as an `ExecutionTimeout` outcome.
//   - `renderValue`: a canonical, structural rendering (sorted keys, NaN === NaN,
//     -0 === 0 as in JSON). A function in an output is refused, not stringified.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import type * as TS from "typescript";
import type { TsModule } from "./differential-fuzz-deps.js";
import type { CallOutcomeSummary } from "./differential-fuzz-types.js";

/** An output (or mutated argument) holds something with no structural rendering. */
export class UnsupportedOutputError extends Error {
	constructor(kind: string) {
		super(`unsupported value in output: ${kind}`);
		this.name = "UnsupportedOutputError";
	}
}

class CallTimeoutError extends Error {}

function renderNumber(n: number): string {
	if (Number.isNaN(n)) return "NaN";
	return Number.isFinite(n) ? String(n) : n > 0 ? "Infinity" : "-Infinity";
}

/** Any non-null object value: arbitrary user data has no narrower static shape. */
type Renderable = object;

function renderPlain(obj: Renderable, seen: Set<Renderable>): string {
	const entries = Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${render(Reflect.get(obj, k), seen)}`);
	return `{${entries.join(",")}}`;
}

function renderObject(obj: Renderable, seen: Set<Renderable>): string {
	if (seen.has(obj)) return "[Circular]";
	seen.add(obj);
	try {
		if (Array.isArray(obj)) return `[${Array.from(obj, (el) => render(el, seen)).join(",")}]`;
		if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "new Date(NaN)" : `new Date(${JSON.stringify(obj.toISOString())})`;
		if (obj instanceof Map) return `new Map([${[...obj].map(([k, v]) => `[${render(k, seen)},${render(v, seen)}]`).join(",")}])`;
		if (obj instanceof Set) return `new Set([${[...obj].map((v) => render(v, seen)).join(",")}])`;
		if (obj instanceof RegExp) return String(obj);
		if (obj instanceof Error) return `new ${obj.constructor.name}(${JSON.stringify(obj.message)})`;
		return renderPlain(obj, seen);
	} finally {
		seen.delete(obj);
	}
}

function render(value: unknown, seen: Set<Renderable>): string {
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "number":
			return renderNumber(value);
		case "bigint":
			return `${value}n`;
		case "boolean":
		case "undefined":
			return String(value);
		case "function":
		case "symbol":
			throw new UnsupportedOutputError(typeof value);
		default:
			return value === null ? "null" : renderObject(value ?? {}, seen);
	}
}

/** Canonical structural rendering of any JSON-like value (also valid JS source). */
export function renderValue(value: unknown): string {
	return render(value, new Set());
}

type AnyCallable = (...args: never[]) => unknown;

const CALL_SCRIPT = new vm.Script("__fn.apply(undefined, __args)");
const CALL_CONTEXT = vm.createContext({});

function invokeWithTimeout(fn: AnyCallable, args: unknown[], timeoutMs: number): unknown {
	Reflect.set(CALL_CONTEXT, "__fn", fn);
	Reflect.set(CALL_CONTEXT, "__args", args);
	return CALL_SCRIPT.runInContext(CALL_CONTEXT, { timeout: timeoutMs });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function";
}

async function settle(value: unknown, timeoutMs: number): Promise<unknown> {
	if (!isThenable(value)) return value;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new CallTimeoutError("async timeout")), timeoutMs);
	});
	try {
		return await Promise.race([Promise.resolve(value), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

function isVmTimeout(err: unknown): boolean {
	return typeof err === "object" && err !== null && Reflect.get(err, "code") === "ERR_SCRIPT_EXECUTION_TIMEOUT";
}

function describeThrown(err: unknown): { errorName: string; errorMessage: string } {
	if (err instanceof CallTimeoutError || isVmTimeout(err)) return { errorName: "ExecutionTimeout", errorMessage: "" };
	if (typeof err !== "object" || err === null) return { errorName: typeof err, errorMessage: String(err) };
	const message = Reflect.get(err, "message");
	return {
		errorName: err.constructor.name,
		errorMessage: typeof message === "string" ? message : "",
	};
}

/** Call `fn(...args)` once and describe everything observable about it. */
export async function summarizeCall(fn: AnyCallable, args: unknown[], timeoutMs: number): Promise<CallOutcomeSummary> {
	let result: CallOutcomeSummary;
	try {
		const value = await settle(invokeWithTimeout(fn, args, timeoutMs), timeoutMs);
		result = { threw: false, valueJson: renderValue(value) };
	} catch (err) {
		if (err instanceof UnsupportedOutputError) throw err;
		result = { threw: true, valueJson: "", ...describeThrown(err) };
	}
	return { ...result, argsAfterJson: renderValue(args) };
}

export function outcomesEqual(a: CallOutcomeSummary, b: CallOutcomeSummary): boolean {
	return (
		a.threw === b.threw &&
		a.valueJson === b.valueJson &&
		a.errorName === b.errorName &&
		a.errorMessage === b.errorMessage &&
		a.argsAfterJson === b.argsAfterJson
	);
}

function resolveSpecifier(spec: string, absPath: string): string | undefined {
	if (spec.startsWith(".")) return resolve(dirname(absPath), spec);
	if (isBuiltin(spec) || spec.startsWith("/") || spec.startsWith("file:")) return undefined;
	try {
		return pathToFileURL(createRequire(absPath).resolve(spec)).href;
	} catch {
		return undefined;
	}
}

function isTypeOnly(ts: TsModule, node: TS.ImportDeclaration | TS.ExportDeclaration): boolean {
	return ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
}

function collectSpecifiers(ts: TsModule, sf: TS.SourceFile): TS.StringLiteral[] {
	const found: TS.StringLiteral[] = [];
	const visit = (node: TS.Node): void => {
		const spec =
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !isTypeOnly(ts, node)
				? node.moduleSpecifier
				: undefined;
		const dynamicArg =
			ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
		for (const lit of [spec, dynamicArg]) if (lit !== undefined && ts.isStringLiteral(lit)) found.push(lit);
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

/**
 * Make a source's module specifiers independent of where the file is written:
 * relative ones become absolute paths, bare package names resolve from the
 * ORIGINAL file's location. Unresolvable names, builtins and type-only imports
 * are left alone. Not handled: `import.meta.url` / `__dirname` / `require()`.
 */
export function rewriteImports(ts: TsModule, source: string, absPath: string): string {
	const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true);
	const edits = collectSpecifiers(ts, sf)
		.map((lit) => ({ lit, to: resolveSpecifier(lit.text, absPath) }))
		.filter((e): e is { lit: TS.StringLiteral; to: string } => e.to !== undefined)
		.sort((a, b) => b.lit.getStart(sf) - a.lit.getStart(sf));
	let out = source;
	for (const { lit, to } of edits) {
		out = out.slice(0, lit.getStart(sf)) + JSON.stringify(to) + out.slice(lit.getEnd());
	}
	return out;
}

export interface ModulePair {
	pristine: Record<string, unknown>;
	mutant: Record<string, unknown>;
	dir: string;
	/** Remove the temp dir. Safe to call more than once. */
	dispose: () => void;
}

async function importModule(path: string): Promise<Record<string, unknown>> {
	const specifier = pathToFileURL(path).href;
	const mod: unknown = await import(/* @vite-ignore */ specifier);
	if (typeof mod !== "object" || mod === null) throw new Error(`module ${path} did not evaluate to a namespace`);
	return Object.fromEntries(Object.entries(mod));
}

/** Write both JS sources to a private temp dir and import them under distinct names. */
export async function loadModulePair(pristineJs: string, mutantJs: string): Promise<ModulePair> {
	const dir = mkdtempSync(join(tmpdir(), "il-fuzz-"));
	const dispose = (): void => rmSync(dir, { recursive: true, force: true });
	try {
		const pristinePath = join(dir, "pristine.mjs");
		const mutantPath = join(dir, "mutant.mjs");
		writeFileSync(pristinePath, pristineJs);
		writeFileSync(mutantPath, mutantJs);
		const pristine = await importModule(pristinePath);
		const mutant = await importModule(mutantPath);
		return { pristine, mutant, dir, dispose };
	} catch (err) {
		dispose();
		throw err;
	}
}
