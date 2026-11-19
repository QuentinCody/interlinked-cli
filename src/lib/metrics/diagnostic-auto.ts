import { measurePythonDiagnosticInventoryAsync } from "./diagnostic-python.js";
import { measureDiagnosticInventory, type DiagnosticReport } from "./diagnostic-report.js";
import { collectRepositoryInventory, inventoryHash } from "./inventory.js";
import { refineInventory } from "./inventory-refine.js";
import type { InventoryOptions } from "./inventory-paths.js";
import { sourceLanguage } from "./inventory-roles.js";
import type { RepositoryInventory } from "./measurement-types.js";

/**
 * A tree with both JS/TS and Python product source gets one report per language. Each report has its own counting
 * contract, population and denominators; nothing is summed across languages.
 */
export interface ProfileSelection {
	rule: "only-js-ts" | "only-python" | "both-languages" | "no-supported-language-default-js-ts";
	/** Product files per language in the measured population (the source-role population); the shares sum to 1 over all languages. */
	languages: Record<string, number>;
	shares: Record<string, number>;
}
export interface MixedDiagnosticReport { schemaVersion: 1; modelCalls: 0; mixed: true; profileSelection: ProfileSelection; profiles: DiagnosticReport[]; }
export type AutoDiagnosticReport = (DiagnosticReport & { profileSelection: ProfileSelection }) | MixedDiagnosticReport;

function selectProfile(inventory: RepositoryInventory): ProfileSelection {
	const languages: Record<string, number> = {};
	for (const file of inventory.files) if (file.role === "product") languages[file.language ?? "unknown"] = (languages[file.language ?? "unknown"] ?? 0) + 1;
	const total = Object.values(languages).reduce((sum, count) => sum + count, 0);
	const shares = Object.fromEntries(Object.entries(languages).map(([language, count]) => [language, Math.round((count / total) * 10_000) / 10_000]));
	const python = (languages.python ?? 0) > 0, jsTs = Object.keys(languages).some(isJsTs);
	const rule = python && jsTs ? "both-languages" : python ? "only-python" : jsTs ? "only-js-ts" : "no-supported-language-default-js-ts";
	return { rule, languages, shares };
}

const JS_TS = new Set(["javascript", "typescript"]);
const isJsTs = (language: string | null): boolean => language !== null && JS_TS.has(language);

export function isMixedDiagnosticReport(report: DiagnosticReport | AutoDiagnosticReport): report is MixedDiagnosticReport {
	return "mixed" in report;
}

/** Drop every file of the other supported language; unsupported languages stay so each report still names them as gaps. */
function withoutLanguage(inventory: RepositoryInventory, drop: (language: string | null) => boolean): RepositoryInventory {
	const files = inventory.files.filter(file => !drop(file.language));
	const product = files.filter(file => file.role === "product");
	return { ...inventory, files, gaps: inventory.gaps.filter(gap => !drop(sourceLanguage(gap.path))),
		inputHash: inventoryHash(files), sourceHash: inventoryHash(product) };
}

async function measureAutoDiagnosticInventory(inventory: RepositoryInventory, options: Pick<InventoryOptions, "signal"> = {}): Promise<AutoDiagnosticReport> {
	const profileSelection = selectProfile(inventory);
	if (profileSelection.rule === "both-languages") {
		const js = measureDiagnosticInventory(withoutLanguage(inventory, language => language === "python"));
		const python = await measurePythonDiagnosticInventoryAsync(withoutLanguage(inventory, isJsTs), options);
		return { schemaVersion: 1, modelCalls: 0, mixed: true, profileSelection, profiles: [js, python] };
	}
	const report = profileSelection.rule === "only-python"
		? await measurePythonDiagnosticInventoryAsync(inventory, options) : measureDiagnosticInventory(inventory);
	return { ...report, profileSelection };
}

export async function collectAutoDiagnosticReport(root: string, options: InventoryOptions = {}): Promise<AutoDiagnosticReport> {
	options.signal?.throwIfAborted();
	const inventory = refineInventory(collectRepositoryInventory(root, { ...options, resourcePolicy: "foreground-survey" }));
	return measureAutoDiagnosticInventory(inventory, options);
}
