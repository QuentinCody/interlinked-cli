// CLASS: Commander flag spelling used as an options-object attribute.
// FIRES WHEN: resolved Commander options reach a same-file or local imported
// handler read that uses a dashed key before mutation or an unknown escape.
// DOES NOT FIRE: normalization outputs, canonical fallbacks, custom mappings,
// unrelated bindings, unsupported imports or reads after unknown escapes.
// CALIBRATION: advisory, with independent real-repository controls.
// KNOWN GAPS: general dataflow, re-exports, CommonJS and partial hook importers.
// HOW TO EXTEND: add source-bound links and independent positive/negative controls.
import { reportNotMeasured } from "./check-root.js";
import { analyzeCommanderModule, potentialCommanderHandlerRead, sameFileCommanderMatches } from "./commander-option-attribute-model.js";
import { commanderProjectMatches, commanderProjectView } from "./commander-option-project.js";
import type { InlineMatch } from "./shared.js";

/** One shared registry entry supplies both standalone and scoped project evidence. */
export function detectCommanderOptionAttribute(content: string, filePath: string): InlineMatch[] {
	if (!/\.[cm]?[jt]sx?$/.test(filePath)) return [];
	const registrar = content.includes("commander");
	const rawRead = /\[\s*["'][^"'\n]*-[^"'\n]*["']\s*\]/.test(content);
	if (!registrar && !rawRead) return [];
	const view = commanderProjectView(content, filePath);
	const analysis = analyzeCommanderModule(content, filePath, !view, view ? reason => view.gap(filePath, reason) : undefined);
	if (!analysis) return [];
	const incoming = rawRead && potentialCommanderHandlerRead(analysis);
	if (!registrar && !incoming) return [];
	if (!registrar && !view) {
		reportNotMeasured("commander_option_attribute", "reverse importer evidence is unavailable for cross-file option reads");
		return [];
	}
	const local = registrar ? sameFileCommanderMatches(analysis) : [];
	return view ? [...local, ...commanderProjectMatches(view, analysis, filePath, registrar, incoming)] : local;
}
