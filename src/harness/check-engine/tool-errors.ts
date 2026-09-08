/** Match structured process/filesystem errors without assuming the thrown value is an Error. */
export function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
