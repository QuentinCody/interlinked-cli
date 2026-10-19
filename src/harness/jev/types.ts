// interlinked-tdd: exempt
// Jev (TypeSafe System One) — request/response contract. Types only.
//
// Mirrors https://docs.typesafe.ai/api (v1, `POST /v1/systemone`). Kept as a
// hand-written subset so the harness carries no SDK dependency: the client is
// a single fetch. Every question is evaluated in parallel against one `state`;
// answers come back under the same ids. Noul carries a probability only;
// Choice and Score also carry `confidence` derived from their distribution.

/** JSON-shaped instruction/criteria payload (strings, objects, arrays). */
export type JevEntry = string | number | boolean | null | JevEntry[] | { [key: string]: JevEntry };

export interface JevNoulQuestion {
	type: "noul";
	instructions: JevEntry;
	criteria?: { true?: JevEntry; false?: JevEntry };
}

export interface JevChoiceQuestion {
	type: "choice";
	instructions: JevEntry;
	/** option id → description (null when the id is self-explanatory) */
	criteria: Record<string, JevEntry>;
}

export interface JevScoreQuestion {
	type: "score";
	instructions: JevEntry;
	/** ordered level descriptions, low → high (2..10 entries) */
	criteria: JevEntry[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevNoulAnswer {
	type: "noul";
	noul: number;
}

export interface JevChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface JevScoreAnswer {
	type: "score";
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResponse {
	model: string;
	answers: Record<string, JevAnswer>;
	usage: { input_tokens: number; output_tokens: number };
}

/** The `jev` section of guard-rules.local.json (personal tier, default OFF). The
 *  internal runner ignores it; the edit shadow reads `enabled` + `shadow_*`. */
export interface JevConfig {
	/** Master switch. Nothing calls Jev while false. */
	enabled?: boolean;
	/** Model id; `jev-latest` when absent. */
	model?: string;
	/** Per-request deadline. */
	timeout_ms?: number;
	/** Session spend ceiling (USD, input tokens at list price); calls stop when crossed. */
	max_spend_usd?: number;
	/** Override for tests / self-hosted proxies. */
	endpoint?: string;
	/** Experiment E7: one shadow question per cappable-file edit, logged to
	 *  `.interlinked/decision-shadow.jsonl`. Never warns, never blocks. Default false. */
	shadow_edits?: boolean;
	/** Which files the edit shadow asks about. `cappable` (default) = `isCappableFile`
	 *  (no tests / generated / scratch). `code` = any .ts/.mts/.tsx/.js/.mjs/.py under
	 *  the repo root except tests, `.d.ts`, generated/dist/node_modules — scratch/ counts. */
	shadow_scope?: "cappable" | "code";
	/** Per-daemon spend ceiling for the edit shadow (USD). Default 0.50. */
	shadow_max_spend_usd?: number;
	/** Per-request deadline for the edit shadow. Default 1500 ms. */
	shadow_timeout_ms?: number;
}

/** Decision-model backends a decision shadow can ask. `clef_flash` = hosted
 *  Cloudflare Workers AI `@cf/cloudflare/clef-flash` (token + account id from
 *  CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, env or config.local.json);
 *  `jev` = TypeSafe Jev (TYPESAFE_API_KEY, and `jev.enabled` must be true). */
export type DecisionShadowBackend = "jev" | "clef_flash";

/** The `decision_shadow` section of guard-rules.local.json (personal tier,
 *  default OFF). Program 2026-10-08 unit U1: a second opinion on guard blocks
 *  (E20) and secret-signature hits (E19), LOGGED to decision-shadow.jsonl,
 *  never shown, never blocking (`jev/decision-shadow.ts`). */
export interface DecisionShadowConfig {
	/** Master switch. Nothing is asked while false. */
	enabled?: boolean;
	/** Default `clef_flash`. */
	backend?: DecisionShadowBackend;
	/** Per-surface switches; an absent key counts as ON while `enabled`. */
	surfaces?: { guard_block?: boolean; secret_hit?: boolean };
	/** Per-request deadline; default and ceiling 3000 ms. */
	timeout_ms?: number;
}
