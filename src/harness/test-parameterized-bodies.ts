import type * as TS from "typescript";
import { parseTsSource, type ParsedTsSource } from "./checks/cyclomatic-ast.js";

export interface TestBody { body: string; name: string; end: number; }

function parameterizedBody(node: TS.Node, { ts, sf }: ParsedTsSource): TestBody | null {
	if (!ts.isCallExpression(node) || !ts.isCallExpression(node.expression)) return null;
	const factory = node.expression.expression;
	if (!ts.isPropertyAccessExpression(factory) || factory.name.text !== "each") return null;
	const callback = node.arguments[1];
	if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return null;
	const name = node.arguments[0];
	return {
		body: callback.body.getText(sf),
		name: name && ts.isStringLiteralLike(name) ? name.text : "",
		end: sf.getLineAndCharacterOfPosition(node.getEnd()).line,
	};
}

/** Body ranges for `.each(table)(name, callback)`, excluding table factories. */
export function parameterizedTestBodies(content: string, filePath: string): Map<number, TestBody> {
	const bodies = new Map<number, TestBody>();
	if (!/\.\s*each\s*\(/.test(content)) return bodies;
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return bodies;
	const visit = (node: TS.Node): void => {
		const body = parameterizedBody(node, parsed);
		if (body) bodies.set(parsed.sf.getLineAndCharacterOfPosition(node.getStart(parsed.sf)).line, body);
		parsed.ts.forEachChild(node, visit);
	};
	visit(parsed.sf);
	return bodies;
}
