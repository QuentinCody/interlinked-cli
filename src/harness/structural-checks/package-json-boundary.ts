// ===========================================
// package.json lookup + boundary walking
// ===========================================
// Filesystem helpers shared by the hallucinated-import and cross-package-import
// checks: find the nearest package.json, read its declared dependency names,
// and locate the package boundary a relative specifier crosses.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";

/**
 * Best-effort read of a package.json into a JsonObject; null when unreadable,
 * malformed, or not an object.
 */
function readPackageJson(pkgPath: string): JsonObject | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return isJsonObject(parsed) ? parsed : null;
	} catch {
		/* intentional: best-effort parse — unreadable/malformed
		 * package.json is treated as absent. */
		return null;
	}
}

/** Walk up from the file (max 10 levels) to the closest readable package.json. */
export function loadNearestPackageJson(filePath: string): JsonObject | null {
	let dir = dirname(filePath);
	for (let i = 0; i < 10; i++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) return readPackageJson(pkgPath);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** Union of every dependency name declared across the four dependency fields. */
export function collectDeclaredDeps(pkgJson: JsonObject): Set<string> {
	const allDeps = new Set<string>();
	for (const field of [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		const deps = pkgJson[field];
		if (!isJsonObject(deps)) continue;
		for (const name of Object.keys(deps)) {
			allDeps.add(name);
		}
	}
	return allDeps;
}

/** A package.json marked `private` or carrying `workspaces` is a project root. */
function isProjectRootPackage(pkgPath: string): boolean {
	const pkg = readPackageJson(pkgPath);
	return pkg !== null && Boolean(pkg.private || pkg.workspaces);
}

function packageOwner(dir: string, cache: Map<string, string | null>): string | null {
	const cached = cache.get(dir);
	if (cached !== undefined) return cached;
	const parent = dirname(dir);
	const owner = existsSync(join(dir, "package.json")) ? dir : parent === dir ? null : packageOwner(parent, cache);
	cache.set(dir, owner);
	return owner;
}

/** A resolved relative edge crosses a boundary when its endpoints have different owners. */
export function findCrossPackageBoundary(fromDir: string, toDir: string, cache = new Map<string, string | null>()): string | null {
	const from = packageOwner(fromDir, cache);
	const to = packageOwner(toDir, cache);
	if (from === to) return null;
	if (from !== null && to !== null) {
		// Report the child when leaving it for its parent, otherwise the package entered.
		return relative(to, from).split(sep)[0] === ".." ? to : from;
	}
	const boundary = from ?? to;
	return boundary !== null && !isProjectRootPackage(join(boundary, "package.json")) ? boundary : null;
}
