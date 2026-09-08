import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { QualityCheckConfig } from "../types.js";
import { isStringList } from "./parsed-rule.js";

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** A malformed field does not discard valid sibling overrides. */
export function readLocalQualityCheckOverride(value: unknown): Partial<QualityCheckConfig> | null {
	if (!isJsonObject(value)) return null;
	const result: Partial<QualityCheckConfig> = {};
	if (typeof value.enabled === "boolean") result.enabled = value.enabled;
	if (isStringList(value.file_types)) result.file_types = value.file_types;
	if (finite(value.timeout_ms)) result.timeout_ms = value.timeout_ms;
	if (value.severity === "error" || value.severity === "warning") result.severity = value.severity;
	if (typeof value.command === "string") result.command = value.command;
	if (typeof value.description === "string") result.description = value.description;
	readCheckTuning(result, value);
	return result;
}

function readCheckTuning(result: Partial<QualityCheckConfig>, value: JsonObject): void {
	if (typeof value.skip_test_files === "boolean") result.skip_test_files = value.skip_test_files;
	if (typeof value.use_osv_scanner === "boolean") result.use_osv_scanner = value.use_osv_scanner;
	if (typeof value.offline === "boolean") result.offline = value.offline;
	if (finite(value.slack)) result.slack = value.slack;
	if (finite(value.max_dependent_tests)) result.max_dependent_tests = value.max_dependent_tests;
	if (value.mode === "block" || value.mode === "warn" || value.mode === "off") result.mode = value.mode;
}
