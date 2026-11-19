// Positional boolean advice. Named options carry the missing meaning and are accepted.
// This remains heuristic: a literal positional flag is not proof of two responsibilities.
import { parseTsSource, hasParseErrors } from "./cyclomatic-ast.js";
import { reportNotMeasured } from "./check-root.js";
import { getExtension, isPatternDataFile, isTestSourcePath, JS_TS_EXTS, type InlineMatch } from "./shared.js";

const SAFE_CALLS = new Set([
	"setAttribute", "setItem", "JSON.stringify", "removeEventListener", "addEventListener", "Array.from",
	"Object.defineProperty", "Reflect.defineProperty", "hasOwnProperty", "localStorage", "sessionStorage", "Boolean",
	"mkdir", "mkdirSync", "writeFile", "writeFileSync", "readFile", "readFileSync", "appendFile", "appendFileSync",
	"rm", "rmSync", "stat", "statSync", "lstat", "lstatSync", "access", "accessSync", "open", "openSync", "close",
	"closeSync", "chmod", "chmodSync", "copyFile", "copyFileSync", "rename", "renameSync", "unlink", "unlinkSync",
	"readdir", "readdirSync", "realpath", "realpathSync", "utimes", "utimesSync", "symlink", "symlinkSync",
	"spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "Reflect.get", "Reflect.set",
]);
const TEST_ENTRY_FILE = /(?:^|\/)(?:test|spec)\.[cm]?[jt]sx?$/;

/** Report call lines with a positional boolean after another argument, excluding known APIs. */
export function checkFlagArgument(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath)) || isPatternDataFile(filePath)
		|| isTestSourcePath(filePath) || TEST_ENTRY_FILE.test(filePath.replace(/\\/g, "/"))) return [];
	const parsed = parseTsSource(content, filePath);
	if (!parsed || hasParseErrors(parsed.sf)) {
		reportNotMeasured("flag_argument", "complete TypeScript syntax unavailable");
		return [];
	}
	const { ts, sf } = parsed;
	const lines = new Set<number>();
	const visit = (node: import("typescript").Node): void => {
		if (ts.isCallExpression(node)) {
			const full = node.expression.getText(sf);
			const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : full;
			if (!SAFE_CALLS.has(full) && !SAFE_CALLS.has(name)
				&& node.arguments.slice(1).some(arg => arg.kind === ts.SyntaxKind.TrueKeyword || arg.kind === ts.SyntaxKind.FalseKeyword)) {
				lines.add(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	const raw = content.split("\n");
	return [...lines].slice(0, 8).map(line => ({ line: line + 1, text: (raw[line] ?? "").trim().slice(0, 150) }));
}
