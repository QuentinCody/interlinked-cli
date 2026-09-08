import {
	wireAbsentOptional,
	wireArray,
	wireLiteral,
	wireNumber,
	wireObject,
	wireOptional,
	wireString,
} from "../../../lib/value-validation.js";
import type { CheckResult } from "../types.js";
import type { SidecarOverlayResponse } from "./tsc-overlay-protocol.js";
import type { RunTscOverlayInput } from "./tsc-overlay-service.js";

export const isOverlayParams = wireObject<RunTscOverlayInput>({
	projectRoot: wireString,
	filePath: wireString,
	content: wireString,
	siblings: wireAbsentOptional(wireArray(wireObject({ filePath: wireString, content: wireString }))),
});

// This sidecar only runs TypeScript; another tool name cannot be its finding.
const isTscFinding = wireObject<CheckResult>({
	tool: wireLiteral("tsc"),
	severity: wireLiteral("error", "warning", "info"),
	file: wireString,
	line: wireNumber,
	column: wireAbsentOptional(wireOptional(wireNumber)),
	message: wireString,
	ruleId: wireAbsentOptional(wireOptional(wireString)),
});
const isErrorReply = wireObject({ id: wireNumber, error: wireString });
const isResultReply = wireObject({
	id: wireNumber,
	result: wireArray(isTscFinding),
	notMeasured: wireAbsentOptional(wireString),
});

export function isOverlayResponse(value: unknown): value is SidecarOverlayResponse {
	return isErrorReply(value) || isResultReply(value);
}
