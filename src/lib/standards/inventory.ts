import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { containedFile, hashBytes, SOURCE_ROLE_VERSION } from "../metrics/inventory.js";
import { inventoryPaths, type InventoryOptions } from "../metrics/inventory-paths.js";
import { isJavaScriptLanguage, sourceLanguage, sourceRole } from "../metrics/inventory-roles.js";
import type { InventoryFile, InventoryGap, SourceRole } from "../metrics/measurement-types.js";

export type StandardsScope = "all" | "product";
export interface StandardsInput {
	path: string;
	role: SourceRole;
	language: string | null;
	bytes: number | null;
	sha256: string | null;
	supported: boolean;
	selected: boolean;
	reason: string | null;
}
export interface RoleDenominator { files: number; supportedFiles: number; bytes: number; }
export interface StandardsInventory {
	root: string;
	version: typeof SOURCE_ROLE_VERSION;
	scope: StandardsScope;
	discovery: "git" | "filesystem";
	files: InventoryFile[];
	entries: StandardsInput[];
	byRole: Record<string, RoleDenominator>;
	gaps: InventoryGap[];
	issues: string[];
	inputHash: string;
}

function capture(root: string, path: string, scope: StandardsScope, options: InventoryOptions): { entry: StandardsInput; file: InventoryFile | null } {
	options.signal?.throwIfAborted();
	const role = sourceRole(path), language = sourceLanguage(path);
	const supported = isJavaScriptLanguage(language), selected = supported && (scope === "all" || role === "product");
	const entry: StandardsInput = { path, role, language, supported, selected, bytes: null, sha256: null, reason: supported ? selected ? null : "excluded_by_scope" : "unsupported_language" };
	try {
		const absolute = containedFile(root, path);
		entry.bytes = lstatSync(absolute).size;
		if (!selected) return { entry, file: null };
		if (options.resourcePolicy !== "foreground-survey" && entry.bytes > 2 * 1024 * 1024) throw new Error("Input exceeds shared 2 MiB runtime analysis limit");
		const bytes = readFileSync(absolute), content = bytes.toString("utf8");
		options.signal?.throwIfAborted();
		entry.bytes = bytes.length;
		entry.sha256 = hashBytes(bytes);
		return { entry, file: { path, role, language, content, sha256: entry.sha256 } };
	} catch (error) {
		options.signal?.throwIfAborted();
		entry.reason = error instanceof Error ? error.message : String(error);
		return { entry, file: null };
	}
}

/** Preserve every discovered role while selecting only supported JS/TS text for analysis. */
export function collectStandardsInventory(directory: string, scope: StandardsScope = "all", options: InventoryOptions = {}): StandardsInventory {
	options.signal?.throwIfAborted();
	if (scope !== "all" && scope !== "product") throw new Error("Standards scope must be all or product");
	const root = realpathSync(directory), paths = inventoryPaths(root, options);
	const files: InventoryFile[] = [], entries: StandardsInput[] = [], gaps: InventoryGap[] = [];
	const byRole: Record<string, RoleDenominator> = {};
	for (const rawPath of paths.paths) {
		const { entry, file } = capture(root, rawPath.replaceAll("\\", "/"), scope, options);
		entries.push(entry);
		const role = byRole[entry.role] ??= { files: 0, supportedFiles: 0, bytes: 0 };
		role.files++;
		role.supportedFiles += Number(entry.supported);
		role.bytes += entry.bytes ?? 0;
		if (file) files.push(file);
		else if (entry.selected || entry.bytes === null) gaps.push({ path: entry.path, role: entry.role, reason: entry.reason ?? "source_unavailable" });
	}
	return { root, version: SOURCE_ROLE_VERSION, scope, discovery: paths.discovery, files, entries, byRole, gaps, issues: paths.issues, inputHash: hashBytes(JSON.stringify(entries)) };
}

/** Compare the measured text snapshot and path population with the end of the local census. */
export function compareStandardsSnapshot(inventory: StandardsInventory, options: InventoryOptions = {}) {
	options.signal?.throwIfAborted();
	const changedFiles: string[] = [], unavailableFiles: string[] = [];
	for (const file of inventory.files) {
		options.signal?.throwIfAborted();
		try {
			if (hashBytes(readFileSync(containedFile(inventory.root, file.path))) !== file.sha256) changedFiles.push(file.path);
			options.signal?.throwIfAborted();
		} catch (error) { options.signal?.throwIfAborted(); unavailableFiles.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	const current = inventoryPaths(inventory.root, options), before = new Set(inventory.entries.map(entry => entry.path)), after = new Set(current.paths.map(path => path.replaceAll("\\", "/")));
	const addedPaths = [...after].filter(path => !before.has(path));
	const removedPaths = current.issues.length ? [] : [...before].filter(path => !after.has(path));
	const changed = changedFiles.length + addedPaths.length + removedPaths.length > 0;
	return { state: changed ? "changed" : unavailableFiles.length || current.issues.length ? "inconclusive" : "stable_selected_snapshot",
		selectedFilesChecked: inventory.files.length, changedFiles, unavailableFiles, addedPaths, removedPaths, discoveryIssues: current.issues,
		limitations: ["This comparison binds selected primary text and the discovered path population. Unsupported file contents, compiler dependencies and configuration remain separate live inputs."] };
}
