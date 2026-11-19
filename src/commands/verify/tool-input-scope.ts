import type { ToolId, ToolInputScope } from "../../harness/check-engine/types.js";
import { recordVerifyInputDeferral, recordVerifyInputExclusion } from "./check-timing.js";

/** Native analyzers can inspect a different population from the source inventory.
 * Keep their final scope receipts and expose deliberate exclusions versus gaps. */
export function createToolInputScopeCollector() {
	const scopes = new Map<ToolId, ToolInputScope>();
	return {
		record(input: ToolInputScope): void { scopes.set(input.tool, input); },
		finish(): ToolInputScope[] {
			for (const input of scopes.values()) {
				for (const excluded of input.excludedInputs) recordVerifyInputExclusion(input.tool, excluded);
				for (const unavailable of input.unavailableInputs) recordVerifyInputDeferral(input.tool, unavailable);
			}
			return [...scopes.values()];
		},
	};
}
