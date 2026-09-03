// ===========================================
// Shared adapter tool-class delegation
// ===========================================
// Every runner adapter classifies tool calls through the same shared command
// classifier, threading the adapter's optional user overrides. The delegation
// carries no runner-specific content, so it lives here once instead of being
// copied into each adapter.
//
// This is a DEFAULT, not a constraint. An adapter that needs a runner-specific
// heuristic (e.g. Claude's `MultiEdit` → modify) writes its own
// `classifyToolClass` body and simply stops calling this factory.

import { type ClassifierOverrides, classifyFromToolName } from "../tool-class-classifier.js";
import type { ToolClass } from "../unified-event.js";

/** Build the `RunnerAdapter.classifyToolClass` implementation for an adapter
 *  configured with `overrides`. */
export function adapterToolClassifier(
	overrides: ClassifierOverrides | undefined,
): (toolName: string, toolInput: unknown) => ToolClass {
	return (toolName, toolInput) =>
		classifyFromToolName(toolName, toolInput, overrides ? { overrides } : {});
}
