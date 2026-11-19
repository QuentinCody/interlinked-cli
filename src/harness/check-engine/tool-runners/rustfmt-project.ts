import { statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { discoverFiles } from "../../../commands/verify/file-discovery.js";
import type { InventoryPaths } from "../../../lib/metrics/inventory-paths.js";
import { sourceRole } from "../../../lib/metrics/inventory-roles.js";
import { hasErrorCode } from "../tool-errors.js";

export type RustfmtProjectScope =
	| { mode: "cargo"; manifest: string }
	| { mode: "files"; files: string[] }
	| { mode: "excluded"; category: "file_type_mismatch" | "config_disabled"; reason: string }
	| { mode: "unavailable"; reason: string };

/** Root Cargo owns crate/workspace targets, including deliberately named fixtures.
 * A non-Cargo root formats standalone source while excluding independent fixtures. */
export function rustfmtProjectScope(root: string, inventory?: InventoryPaths): RustfmtProjectScope {
	const manifest = join(root, "Cargo.toml");
	try {
		if (statSync(manifest).isFile()) return { mode: "cargo", manifest };
		return { mode: "unavailable", reason: "Project Cargo.toml is not a regular manifest file" };
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) return { mode: "unavailable", reason: `Cannot inspect project Cargo.toml: ${String(error)}` };
	}
	const issues = [...(inventory?.issues ?? [])];
	const paths = inventory ? inventory.paths.map(file => resolve(root, file)) : discoverFiles(root, {
		onUnavailable: issue => issues.push(`${issue.file}: ${issue.reason}`),
	});
	if (issues.length) return { mode: "unavailable", reason: issues.join("\n") };
	const rust = paths.filter(file => extname(file).toLowerCase() === ".rs");
	const files = [...new Set(rust.filter(file => !["fixture", "generated", "vendor"].includes(sourceRole(relative(root, file)))))].sort();
	if (files.length) return { mode: "files", files };
	if (rust.length) return { mode: "excluded", category: "config_disabled",
		reason: "Rust project scope excludes independent fixture, generated and vendor source; select that crate root or an explicit file to format it" };
	return { mode: "excluded", category: "file_type_mismatch", reason: "No selected Rust source files" };
}
