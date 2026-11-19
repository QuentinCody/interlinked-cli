import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { containedFile, hashBytes } from "../metrics/inventory.js";

const FLAGS = ["strict", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes", "noImplicitOverride", "noFallthroughCasesInSwitch"] as const;
export interface StandardsCompilerConfig {
	file: string;
	sha256: string | null;
	settings: Record<(typeof FLAGS)[number], boolean | null>;
	diagnostics: string[];
}
export interface StandardsCompiler {
	state: "measured" | "inconclusive" | "missing" | "unsupported";
	version: string | null;
	configs: StandardsCompilerConfig[];
	inputs: { file: string; sha256: string }[];
	limitations: string[];
}

/** Parse JSON compiler metadata with the CLI compiler API, without running a target compiler or config script. */
export function measureStandardsCompiler(root: string, paths: readonly string[], parser: typeof parseTsSource = parseTsSource): StandardsCompiler {
	root = realpathSync(root);
	const parsed = parser("", "compiler-availability.ts");
	const result: StandardsCompiler = { state: "missing", version: parsed?.ts.version ?? null, configs: [], inputs: [], limitations: ["Absent flags remain null. Compiler settings do not establish a successful compilation.", "Inherited JSON configuration and package metadata are live read-only inputs. No target scripts or compiler plugins run."] };
	if (!parsed) { result.state = "unsupported"; return result; }
	if (!paths.length) return result;
	const { ts } = parsed, inputs = new Map<string, string>();
	for (const path of paths) {
		const settings = { strict: null, noUncheckedIndexedAccess: null, exactOptionalPropertyTypes: null, noImplicitOverride: null, noFallthroughCasesInSwitch: null };
		const config: StandardsCompilerConfig = { file: path, sha256: null, settings, diagnostics: [] };
		result.configs.push(config);
		try {
			const absolute = containedFile(root, path);
			config.sha256 = hashBytes(readFileSync(absolute));
			const options = ts.getParsedCommandLineOfConfigFile(absolute, { noEmit: true }, { ...ts.sys,
				readFile(file) { const text = ts.sys.readFile(file); if (text !== undefined) inputs.set(relative(root, resolve(file)), hashBytes(text)); return text; },
				onUnRecoverableConfigFileDiagnostic(diagnostic) { config.diagnostics.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")); },
			});
			for (const diagnostic of options?.errors ?? []) config.diagnostics.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
			for (const flag of FLAGS) { const value = options?.options[flag]; config.settings[flag] = typeof value === "boolean" ? value : null; }
		} catch (error) { config.diagnostics.push(error instanceof Error ? error.message : String(error)); }
	}
	result.inputs = [...inputs].map(([file, sha256]) => ({ file, sha256 }));
	result.state = result.configs.some(config => config.diagnostics.length) ? "inconclusive" : "measured";
	return result;
}
