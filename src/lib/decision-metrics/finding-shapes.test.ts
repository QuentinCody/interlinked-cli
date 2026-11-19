import { describe, expect, it } from "vitest";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { transactionNetworkWait } from "./finding-shapes.js";

describe("transaction evidence shapes", () => {
	it.each([
		["P1", "db.transaction(async tx => { await fetch(url); });", 1],
		["N1", "db.transaction(async tx => { await tx.get(key); });", 0],
		["N2", "db.transaction(async tx => { const later = async () => await fetch(url); return later; });", 0],
	])("%s: reports direct external waits, not transaction storage or deferred functions", (_id, source, count) => {
		const parsed = parseTsSource(String(source), "src/example.ts")!;
		const call = parsed.sf.statements[0]!;
		if (!parsed.ts.isExpressionStatement(call) || !parsed.ts.isCallExpression(call.expression)) throw new Error("Expected call fixture");
		expect(transactionNetworkWait(call.expression, parsed.ts)).toHaveLength(Number(count));
	});
});
