// ===========================================
// Soft deadline for `verify --timeout`
// ===========================================
// The CLI supervisor kills the verify child at `--timeout`, and a killed child prints nothing. The child therefore
// stops itself a little earlier: it checks this soft deadline between files and checks, then prints a partial report.
// The supervisor's hard kill stays as the backstop for code that never yields (synchronous detectors are not interruptible).

export const SOFT_DEADLINE_ENV = "INTERLINKED_VERIFY_SOFT_DEADLINE_AT";
const MARGIN_SHARE = 0.2;
const MARGIN_CAP_MS = 30_000;

/** Absolute epoch-ms soft deadline for a command that started at `startMs` with `--timeout timeoutMs`; undefined when there is no timeout. */
export function softDeadlineFor(startMs: number, timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined || timeoutMs <= 0) return undefined;
	return startMs + timeoutMs - Math.min(MARGIN_CAP_MS, Math.floor(timeoutMs * MARGIN_SHARE));
}

/** `{ deadlineAt }` for `withVerifyTimings` when the command has a soft deadline, else nothing. */
export function softDeadlineOption(timeoutMs: number | undefined): { deadlineAt?: number } {
	const deadlineAt = resolveSoftDeadline(timeoutMs, Date.now());
	return deadlineAt === undefined ? {} : { deadlineAt };
}

/** The supervisor's deadline (environment) when it set one, else the command's own `--timeout` counted from `nowMs`. */
export function resolveSoftDeadline(timeoutMs: number | undefined, nowMs: number, env: Record<string, string | undefined> = process.env): number | undefined {
	const given = env[SOFT_DEADLINE_ENV];
	if (given !== undefined && /^\d+$/.test(given) && Number.isSafeInteger(Number(given))) return Number(given);
	return softDeadlineFor(nowMs, timeoutMs);
}
