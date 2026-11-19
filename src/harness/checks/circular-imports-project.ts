import { relative, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { parseImports, resolveImportPath } from "../project-graph.js";
import { getExtension, isTestFile, JS_TS_EXTS, stripComments, type InlineMatch } from "./shared.js";
import type { ProjectCheckEvidence } from "./project-check-evidence.js";

type ImportGraph = ReadonlyMap<string, readonly string[]>;
interface ComponentMembership { size: number; first: string; second: string; }
const indices = new WeakMap<ProjectCheckEvidence, Map<string, ComponentMembership>>();

/** Explicit frames keep the first Kosaraju pass independent of call-stack depth. */
function finishOrder(graph: ImportGraph): string[] {
	const order: string[] = [];
	const seen = new Set<string>();
	for (const start of graph.keys()) {
		if (seen.has(start)) continue;
		seen.add(start);
		const stack = [{ file: start, next: 0 }];
		while (stack.length > 0) {
			const frame = nonNull(stack.at(-1));
			const neighbors = graph.get(frame.file) ?? [];
			if (frame.next === neighbors.length) {
				order.push(frame.file);
				stack.pop();
				continue;
			}
			const next = nonNull(neighbors[frame.next++]);
			if (seen.has(next)) continue;
			seen.add(next);
			stack.push({ file: next, next: 0 });
		}
	}
	return order;
}

function reverseGraph(graph: ImportGraph): Map<string, string[]> {
	const reversed = new Map<string, string[]>();
	for (const [file, neighbors] of graph) {
		if (!reversed.has(file)) reversed.set(file, []);
		for (const neighbor of neighbors) {
			const incoming = reversed.get(neighbor) ?? [];
			incoming.push(file);
			reversed.set(neighbor, incoming);
		}
	}
	return reversed;
}

/** Linear graph traversal computes complete components without enumerating cycles. */
export function findStrongComponents(graph: ImportGraph): string[][] {
	const reversed = reverseGraph(graph);
	const seen = new Set<string>();
	const components: string[][] = [];
	for (const start of finishOrder(graph).reverse()) {
		if (seen.has(start)) continue;
		const members: string[] = [];
		const stack = [start];
		seen.add(start);
		while (stack.length > 0) {
			const file = nonNull(stack.pop());
			members.push(file);
			for (const neighbor of reversed.get(file) ?? []) {
				if (seen.has(neighbor)) continue;
				seen.add(neighbor);
				stack.push(neighbor);
			}
		}
		components.push(members);
	}
	return components;
}

function selectedImportTarget(evidence: ProjectCheckEvidence, graph: ImportGraph, from: string, specifier: string): string | null {
	let target: string | null;
	try { target = resolveImportPath(resolve(evidence.root, from), specifier); }
	catch (error) {
		evidence.reportUnavailable("circular_imports", from, `Import "${specifier}" could not be resolved (${error instanceof Error ? error.message : String(error)})`);
		return null;
	}
	if (!target) {
		evidence.reportUnavailable("circular_imports", from, `Import "${specifier}" is unresolved within the selected source graph`);
		return null;
	}
	const rel = relative(evidence.root, target);
	if (graph.has(rel)) return rel;
	if (JS_TS_EXTS.has(getExtension(target))) evidence.reportUnavailable("circular_imports", from, `Import "${specifier}" resolves outside selected source evidence (${rel})`);
	return null;
}

function sourceTargets(evidence: ProjectCheckEvidence, graph: ImportGraph, source: { file: string; content: string }): string[] {
	let edges: ReturnType<typeof parseImports>;
	try {
		// Documentation import() expressions are type context, not runtime edges.
		const needsCommentMask = [...source.content.matchAll(/\/\*[\s\S]*?(?:\*\/|$)/g)].some(block => /\b(?:import|require)\b/.test(block[0]));
		const content = needsCommentMask ? stripComments(source.content) : source.content;
		edges = parseImports(content, resolve(evidence.root, source.file));
	} catch (error) {
		evidence.reportUnavailable("circular_imports", source.file, `Import syntax could not be analyzed (${error instanceof Error ? error.message : String(error)})`);
		return [];
	}
	const targets = new Set<string>();
	const specifiers = new Set<string>();
	for (const edge of edges) {
		// A lazy `import()` runs after load, so it cannot close a load-time cycle.
		if (edge.isTypeOnly || edge.isDynamic === true || (!edge.specifier.startsWith(".") && !edge.specifier.startsWith("/"))) continue;
		if (specifiers.has(edge.specifier)) continue;
		specifiers.add(edge.specifier);
		const target = selectedImportTarget(evidence, graph, source.file, edge.specifier);
		if (target !== null) targets.add(target);
	}
	return [...targets];
}

function projectMembership(evidence: ProjectCheckEvidence): Map<string, ComponentMembership> {
	const cached = indices.get(evidence);
	if (cached) return cached;
	const graph = new Map(evidence.listFiles().map(file => [file, [] as string[]]));
	// Preserve target applicability. A skipped source only contributes context
	// when an eligible source actually imports it.
	const pending = evidence.listFiles().filter(file => !isTestFile(file) && !file.endsWith(".d.ts") && !evidence.isExcluded(file));
	const visited = new Set<string>();
	for (let index = 0; index < pending.length; index++) {
		const file = nonNull(pending[index]);
		if (visited.has(file)) continue;
		visited.add(file);
		let content: string;
		try { content = evidence.readFile(file); }
		catch (error) {
			evidence.reportUnavailable("circular_imports", file, `Import source could not be read (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		const targets = sourceTargets(evidence, graph, { file, content });
		graph.set(file, targets);
		pending.push(...targets);
	}
	const membership = new Map<string, ComponentMembership>();
	for (const component of findStrongComponents(graph)) {
		// Preserve the existing self-import-only exclusion.
		if (component.length < 2) continue;
		const info = { size: component.length, first: nonNull(component[0]), second: nonNull(component[1]) };
		for (const file of component) membership.set(file, info);
	}
	indices.set(evidence, membership);
	return membership;
}

/** One membership finding per eligible cyclic module. Counts are modules,
 * not an enumeration or count of every simple cycle in a component. */
export function projectCircularImports(evidence: ProjectCheckEvidence, file: string): InlineMatch[] {
	if (evidence.isExcluded(file)) return [];
	const rel = relative(evidence.root, resolve(evidence.root, file));
	const membership = projectMembership(evidence).get(rel);
	if (!membership) return [];
	const peer = rel === membership.first ? membership.second : membership.first;
	return [{ line: 1, text: `import cycle: ${rel} belongs to a strongly connected component with ${membership.size} modules (including ${peer})` }];
}
