import { natural, record, textField } from "./evidence-json.js";

export interface PythonStatement { line: number; endLine: number; start: number; end: number; }
export interface PythonDeclaration { name: string; line: number; exported: boolean; decorated: boolean; uses: number; }
/** Per-module facts read by the unused, disconnected, correctness and contract adapters. */
export interface PythonModuleFacts {
	/** Executable statements at every depth (definitions, imports, pass, global and docstrings excluded). */
	statements: PythonStatement[];
	/** First top-level binding of each non-dunder name. `exported` follows `__all__` when it is a literal, else the underscore rule. */
	declarations: PythonDeclaration[];
	/** A top-level `if __name__ == "__main__"` guard: the file is a script entry. */
	mainGuard: boolean;
	/** Public names the module binds (or `__all__` when it is a literal). */
	exports: string[];
	/** The module has `from x import *`, so its export list is incomplete without the target. */
	starImport: boolean;
	/** Lines of `import_module(x)` / `__import__(x)` calls whose module name is not a string literal. */
	dynamicImports: number[];
}

/** An `export` contract for a Python module: the name is a public binding or listed in `__all__`. A star import leaves the answer open. */
export function pythonExportCheck(facts: PythonModuleFacts | undefined, path: string, name: string): boolean | string {
	if (facts === undefined) return `Export analysis unavailable for ${path}`;
	if (facts.exports.includes(name)) return true;
	return facts.starImport ? `Export analysis incomplete for ${path}: a star import may supply ${name}` : false;
}

function invalid(label: string): Error { return new Error(`Invalid Python analyzer ${label}`); }
function list(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw invalid(label);
	return value;
}
function flag(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw invalid(label);
	return value;
}

function statement(value: unknown): PythonStatement {
	const row = list(value, "statement");
	if (row.length !== 4) throw invalid("statement");
	return { line: natural(row[0], "statement line"), endLine: natural(row[1], "statement end line"), start: natural(row[2], "statement start"), end: natural(row[3], "statement end") };
}

function declaration(value: unknown): PythonDeclaration {
	const row = record(value, "declaration");
	return { name: textField(row.name, "declaration name"), line: natural(row.line, "declaration line"), exported: flag(row.exported, "declaration exported"),
		decorated: flag(row.decorated, "declaration decorated"), uses: natural(row.uses, "declaration uses") };
}

export function parsePythonFacts(value: unknown): PythonModuleFacts {
	if (value === undefined || value === null) throw invalid("facts");
	const row = record(value, "facts");
	return { statements: list(row.statements, "statements").map(statement), declarations: list(row.declarations, "declarations").map(declaration),
		mainGuard: flag(row.mainGuard, "mainGuard"), exports: list(row.exports, "exports").map(name => textField(name, "export")), starImport: flag(row.starImport, "starImport"),
		dynamicImports: list(row.dynamicImports, "dynamicImports").map(line => natural(line, "dynamic import line")) };
}
