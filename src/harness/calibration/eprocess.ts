// ===========================================
// Anytime-valid e-process calibrator (DW P4 §6 — the anti-derailment layer)
// ===========================================
// Replaces fixed cutoffs ("3 flakes → alarm") with a statistically valid test
// that can be monitored at EVERY step without inflating false alarms — the whole
// point being to cut the FP-derailment that makes agents restart.
//
// Construction: a fixed-alternative likelihood-ratio martingale for a streaming
// Bernoulli rate exceeding a baseline p0. Each observation x∈{0,1} multiplies the
// e-value by L(x): L(1)=p1/p0, L(0)=(1-p1)/(1-p0). Under H0 (true rate = p0),
// E[L(x)] = p0·(p1/p0) + (1-p0)·((1-p1)/(1-p0)) = 1, so the running product Eₜ is
// a nonnegative martingale. Ville's inequality then gives P(sup_t Eₜ ≥ 1/α) ≤ α:
// alarming when Eₜ ≥ 1/α controls the false-alarm rate at α at ANY stopping time
// — no multiple-comparisons penalty for looking after every observation.
//
// PURE: state in, state out; no clock, no fs. Kept in log-space to avoid
// underflow over long streams. Intended per-window (reset per session / rolling
// window) so n stays bounded and a genuine regime change alarms promptly; a
// stream that drifts deeply favourable to H0 would otherwise be slow to react.

export interface EProcessConfig {
	/** Null (tolerated) rate, 0<p0<1 — e.g. an acceptable flake rate. */
	p0: number;
	/** Alternative rate to bet on, p0<p1<1 — where detection power concentrates. */
	p1: number;
	/** Significance; the alarm threshold is 1/α. Default 0.05 → e-value 20. */
	alpha?: number;
}

export interface EProcessState {
	/** log of the running e-value (log 1 = 0 at the start). */
	logE: number;
	/** total observations seen. */
	n: number;
	/** positive observations (for reporting the empirical rate). */
	positives: number;
}

const DEFAULT_ALPHA = 0.05;

/** Clamp a rate into the open interval (0,1) so the log-ratios stay finite. */
function safeRate(p: number): number {
	if (!Number.isFinite(p)) return 0.5;
	return Math.min(1 - 1e-9, Math.max(1e-9, p));
}

/** Validated (p0,p1,alpha) with p0<p1 guaranteed. */
function normalizeConfig(cfg: EProcessConfig): { p0: number; p1: number; alpha: number } {
	const p0 = safeRate(cfg.p0);
	let p1 = safeRate(cfg.p1);
	if (p1 <= p0) p1 = safeRate((p0 + 1) / 2); // bet must be strictly above the null
	const alpha = cfg.alpha && cfg.alpha > 0 && cfg.alpha < 1 ? cfg.alpha : DEFAULT_ALPHA;
	return { p0, p1, alpha };
}

/** A fresh e-process (e-value 1, no observations). */
export function createEProcess(): EProcessState {
	return { logE: 0, n: 0, positives: 0 };
}

/** Fold one Bernoulli observation into the e-process. Pure — returns new state. */
export function observe(state: EProcessState, x: boolean, cfg: EProcessConfig): EProcessState {
	const { p0, p1 } = normalizeConfig(cfg);
	const logL = x ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
	return {
		logE: state.logE + logL,
		n: state.n + 1,
		positives: state.positives + (x ? 1 : 0),
	};
}

/** The current e-value Eₜ = exp(logE). */
export function eValue(state: EProcessState): number {
	return Math.exp(state.logE);
}

/** The alarm threshold 1/α for a config. */
export function alarmThreshold(cfg: EProcessConfig): number {
	return 1 / normalizeConfig(cfg).alpha;
}

/** True when the accumulated evidence rejects H0 (rate is anomalously high) at
 *  level α — valid at any stopping time. */
export function isAnomalous(state: EProcessState, cfg: EProcessConfig): boolean {
	// logE ≥ log(1/α) = -log(α)
	return state.logE >= -Math.log(normalizeConfig(cfg).alpha);
}

interface EProcessSummary {
	n: number;
	positives: number;
	empiricalRate: number;
	eValue: number;
	threshold: number;
	anomalous: boolean;
}

/** Human/telemetry-friendly snapshot of the current verdict. */
export function summarize(state: EProcessState, cfg: EProcessConfig): EProcessSummary {
	return {
		n: state.n,
		positives: state.positives,
		empiricalRate: state.n > 0 ? state.positives / state.n : 0,
		eValue: eValue(state),
		threshold: alarmThreshold(cfg),
		anomalous: isAnomalous(state, cfg),
	};
}

/** Fold a whole stream through a fresh e-process (convenience for batch use). */
export function runEProcess(observations: readonly boolean[], cfg: EProcessConfig): EProcessState {
	let state = createEProcess();
	for (const x of observations) state = observe(state, x, cfg);
	return state;
}
