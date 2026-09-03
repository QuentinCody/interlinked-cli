// ===========================================
// package.json lookup + boundary walking
// ===========================================
// Filesystem helpers shared by the hallucinated-import and cross-package-import
// checks: find the nearest package.json, read its declared dependency names,
// and locate the package boundary a relative specifier crosses.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/**
 * Walk from the importing file's directory up one level per `..` segment,
 * returning the first non-project-root package.json directory crossed.
 */
export function findCrossPackageBoundary(
	filePath: string,
	fileDir: string,
	specifier: string,
): string | null {
	const steps = specifier.split("/").filter((s) => s === "..").length;
	let dir = fileDir;
	for (let i = 0; i < steps && i < 10; i++) {
		dir = dirname(dir);
		const pkgPath = join(dir, "package.json");
		// A different package: only flag it when it is not the project root.
		if (!existsSync(pkgPath) || dir === dirname(filePath)) continue;
		if (!isProjectRootPackage(pkgPath)) return dir;
	}
	return null;
}
