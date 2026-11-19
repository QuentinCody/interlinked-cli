import type { CheckResult } from "./types.js";

/** Match structured process/filesystem errors without assuming the thrown value is an Error. */
export function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Findings remain evidence while incomplete execution retains an unavailable scope. */
export class PartialToolReportError extends Error {
	constructor(message: string, readonly results: CheckResult[], options?: ErrorOptions) {
		super(message, options);
		this.name = "PartialToolReportError";
	}
}
