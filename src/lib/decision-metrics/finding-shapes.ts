import type * as TS from "typescript";

export interface ShapeCandidate { family: string; name: string; node: TS.Node; claim: string; declaration?: TS.Node; }

/** Direct awaited network candidates only; unresolved helper effects are not a purity proof. */
export function transactionNetworkWait(call: TS.CallExpression, ts: typeof TS): TS.CallExpression[] {
	if (!/\.(?:transaction|atomic)$/.test(call.expression.getText())) return [];
	const result: TS.CallExpression[] = [];
	for (const argument of call.arguments) {
		if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) continue;
		const visit = (node: TS.Node): void => {
			if (ts.isFunctionLike(node)) return;
			if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && /^(?:fetch|(?:axios|http|https)\.(?:get|post|request))$/.test(node.expression.expression.getText())) result.push(node.expression);
			ts.forEachChild(node, visit);
		};
		visit(argument.body);
	}
	return result;
}

function brandCandidate(node: TS.AssertionExpression, checker: TS.TypeChecker, ts: typeof TS): ShapeCandidate | null {
	if (node.type.getText() === "const") return null;
	const type = checker.getTypeAtLocation(node.type);
	const property = type.getProperties().find(property => {
		if (/^__(?:brand|digest)$/.test(property.name)) return true;
		return property.declarations?.some(declaration => {
			if (!ts.isPropertySignature(declaration) || !ts.isComputedPropertyName(declaration.name)) return false;
			const key = declaration.name.expression, symbol = checker.getSymbolAtLocation(key);
			if (symbol?.declarations?.some(owner => owner.getSourceFile().hasNoDefaultLib)) return false;
			return !!(checker.getTypeAtLocation(key).flags & ts.TypeFlags.UniqueESSymbol);
		});
	});
	if (!property) return null;
	const declaration = property.declarations?.[0];
	return { family: "brand_ownership", name: "brand-construction", node, claim: `A branded value is asserted as ${node.type.getText()}; determine whether this site is an authorized constructor under an explicit ownership policy. Type-definition location alone does not establish ownership.`, ...(declaration ? { declaration } : {}) };
}

/** A sink field name retrieves evidence; only the supplied provenance/policy can classify sensitivity. */
function secretCandidate(call: TS.CallExpression, checker: TS.TypeChecker, ts: typeof TS): ShapeCandidate[] {
	if (!/^(?:console|logger|log)\.(?:log|info|warn|error|debug)$/.test(call.expression.getText())) return [];
	const candidates: TS.PropertyAssignment[] = [];
	const inspect = (node: TS.Node): void => {
		if (ts.isPropertyAssignment(node) && /(?:token|secret|password|credential|api_?key)/i.test(node.name.getText())) {
			const type = checker.getTypeAtLocation(node.initializer);
			const parts = type.isUnion() ? type.types : [type];
			if (!parts.every(part => !!(part.flags & ts.TypeFlags.BooleanLike))) candidates.push(node);
		}
		ts.forEachChild(node, inspect);
	};
	for (const argument of call.arguments) inspect(argument);
	return candidates.map(node => ({ family: "secret_flow", name: "sensitive-sink", node, claim: `A non-boolean value is logged under sensitive-looking field ${node.name.getText().slice(0, 120)}; trace its origin and redaction against the supplied sensitivity policy before deciding whether credential bytes escape.` }));
}

export function semanticShapeCandidates(node: TS.Node, checker: TS.TypeChecker, ts: typeof TS): ShapeCandidate[] {
	if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
		const candidate = brandCandidate(node, checker, ts);
		return candidate ? [candidate] : [];
	}
	if (!ts.isCallExpression(node)) return [];
	return [
		...secretCandidate(node, checker, ts),
		...transactionNetworkWait(node, ts).map(wait => ({ family: "transaction_scope", name: "transaction-wait", node: wait, claim: `A transaction-shaped callback directly awaits ${wait.expression.getText()}; review the transaction's atomicity and lock contract before deciding whether this external wait is inappropriate.` })),
	];
}
