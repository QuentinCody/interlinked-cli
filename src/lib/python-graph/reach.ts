// Reachability over the Python import graph. Importing a module runs the `__init__.py` of each parent
// package first, so those files are reached too, and so is whatever they import.

import { posix } from "node:path";
import type { PyEdge, PyModule } from "./types.js";

export interface ReachGraph {
	modules: ReadonlyMap<string, PyModule>;
	edges: readonly PyEdge[];
}

const adjacencyCache = new WeakMap<readonly PyEdge[], Map<string, string[]>>();

function adjacencyOf(edges: readonly PyEdge[]): Map<string, string[]> {
	const cached = adjacencyCache.get(edges);
	if (cached) return cached;
	const adjacency = new Map<string, string[]>();
	for (const edge of edges) {
		const list = adjacency.get(edge.from);
		if (list) list.push(edge.to);
		else adjacency.set(edge.from, [edge.to]);
	}
	adjacencyCache.set(edges, adjacency);
	return adjacency;
}

/** The `__init__.py` files of the parent packages, nearest first, stopping at the first directory without one. */
export function parentInits(path: string, modules: ReadonlyMap<string, PyModule>): string[] {
	const found: string[] = [];
	for (let dir = posix.dirname(path); dir !== "." && dir !== "/"; dir = posix.dirname(dir)) {
		const init = `${dir}/__init__.py`;
		if (!modules.has(init)) break;
		if (init !== path) found.push(init);
	}
	return found;
}

/** Modules reached from `roots` by import edges of every kind, plus the package inits that those imports run. */
export function reachableModules(graph: ReachGraph, roots: Iterable<string>): Set<string> {
	const adjacency = adjacencyOf(graph.edges);
	const reached = new Set<string>();
	const queue: string[] = [];
	const visit = (path: string): void => {
		if (reached.has(path) || !graph.modules.has(path)) return;
		reached.add(path);
		queue.push(path);
		for (const init of parentInits(path, graph.modules)) visit(init);
	};
	for (const root of roots) visit(root);
	for (let index = 0; index < queue.length; index++) {
		for (const next of adjacency.get(queue[index] ?? "") ?? []) visit(next);
	}
	return reached;
}

function chain(adjacency: Map<string, string[]>, from: string, to: string): boolean {
	const seen = new Set([from]);
	const queue = [from];
	for (let index = 0; index < queue.length; index++) {
		for (const next of adjacency.get(queue[index] ?? "") ?? []) {
			if (next === to) return true;
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	return false;
}

/** True when an import chain of any length runs from one file to the other, in either direction. */
export function importChainLinks(graph: ReachGraph, a: string, b: string): boolean {
	const adjacency = adjacencyOf(graph.edges);
	return chain(adjacency, a, b) || chain(adjacency, b, a);
}
