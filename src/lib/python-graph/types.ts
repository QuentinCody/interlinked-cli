// interlinked-tdd: exempt
// Shared shapes of the Python import graph. The graph is built from the embedded `ast` analyzer
// (src/commands/check-python-script-*.ts); the JSON it writes is typed in check-python-run.ts.

import type { RawGraphHolders } from "../../commands/check-python-run.js";

export type PyRole = "test" | "example" | "docs" | "script" | "other";

export interface PyDef {
	name: string;
	line: number;
	kind: "function" | "class" | "variable";
	/** A decorator may register the definition when the module loads. */
	decorated: boolean;
	/** The name is read somewhere else in its own module. */
	ownUse: boolean;
}

export interface PyModule {
	path: string;
	role: PyRole;
	mainGuard: boolean;
	/** Names in `__all__`; empty when the module has none. */
	all: string[];
	/** The module star-imports another module. */
	star: boolean;
	/** The module defines `__getattr__`: its name surface is computed. */
	getattr: boolean;
	dynamic: string[];
	defs: PyDef[];
	/** Lines that import or discover modules by a computed name. */
	dynamicComputed: number[];
	/** Glob patterns for `.py` files that this module's loader names (set only when it imports by a computed name). */
	loaderGlobs: string[];
}

export interface PyEdge {
	from: string;
	to: string;
	line: number;
	names: string[];
	star: boolean;
	inFunction: boolean;
	typeOnly: boolean;
	guarded: boolean;
	/** `import`: a static statement. `dynamic`: `import_module("literal")`. `string`: a dotted module path in a string literal. */
	kind: "import" | "dynamic" | "string";
}

/** An import of a first-party module (or a name of one) that does not exist. Third-party and stdlib imports never appear. */
export interface PyUnresolved {
	file: string;
	line: number;
	module: string;
	name: string | null;
	kind: "missing_module" | "missing_name";
}

export type RootKind =
	| "console-script"
	| "entry-point-group"
	| "main-module"
	| "main-guard"
	| "shebang"
	| "test"
	| "conftest"
	| "command"
	| "documented-command"
	| "framework-file"
	| "django-settings"
	| "django-app"
	| "pytest-plugin"
	| "alembic"
	| "loader-glob";

/** A file that is reachable by rule: something outside the import graph starts or loads it. */
export interface EntryRoot {
	path: string;
	kind: RootKind;
	/** What names it: the table, the command line or the rule. */
	evidence: string;
}

export interface PythonGraph {
	modules: Map<string, PyModule>;
	edges: PyEdge[];
	unresolved: PyUnresolved[];
	roots: EntryRoot[];
	importRoots: string[];
	consumed: RawGraphHolders;
	valueUsed: RawGraphHolders;
	getattrOn: RawGraphHolders;
	/** Every `.py` file the analyzer listed, parsed or not. */
	filesPy: number;
	unparsed: number;
	/** Imports the analyzer left unjudged on purpose, by reason (ambiguous root, guarded, generated name). */
	skips: Record<string, number>;
	/** Unused import bindings the analyzer reports. */
	deadImports: { file: string; binding: string }[];
}

export type PythonGraphResult =
	| { status: "ok"; graph: PythonGraph }
	| { status: "unavailable" | "failed" | "empty"; note: string };
