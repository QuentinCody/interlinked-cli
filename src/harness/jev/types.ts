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

/** `jev` block in `.interlinked/config.local.json` (personal tier; default OFF). */
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
}
