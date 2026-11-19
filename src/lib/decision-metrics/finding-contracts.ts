/** Explicit semantic contracts for optional review; none is a deterministic gate. */
export interface FindingContract {
	version: "1";
	invariant: string;
	needed: string[];
	exceptions: string[];
	requiresPolicy: boolean;
}

function contract(invariant: string, needed: string[], exceptions: string[] = [], requiresPolicy = false): FindingContract {
	return { version: "1", invariant, needed, exceptions, requiresPolicy };
}

export const FINDING_CONTRACTS: Record<string, FindingContract> = {
	test_quality: contract("The test must distinguish violations of its stated observable behavior, rather than merely echo its own setup.", ["test", "implementation", "behavioral requirement"], ["Interaction is itself the promised behavior", "A fake isolates an external boundary while real domain behavior is exercised"]),
	cast_soundness: contract("A type assertion must be supported by runtime validation, construction or a documented interoperability invariant.", ["assertion", "value origin", "guards or constructor", "consumers"], ["Negative tests intentionally pass malformed external input", "A verified platform boundary needs a representation cast"]),
	abstraction_value: contract("A wrapper or interface should own a meaningful responsibility or reduce the burden on its callers.", ["implementation", "callers", "stated responsibility"], ["Compatibility, authorization, telemetry or lifecycle ownership is a real responsibility"]),
	error_handling: contract("Expected failure must be handled or propagated according to the supplied API contract, retaining useful error context.", ["failure path", "callers", "failure contract"], ["Declared best-effort telemetry may intentionally discard failures", "Defects may throw"]),
	parser_result: contract("Untrusted input must not be consumed as a domain value before its required shape and parser outcome are established.", ["input origin", "parser", "failure handling", "first consumption"], ["Transparent transport forwards opaque input", "Internal serialization copies an already-established value"]),
	domain_state: contract("Representations should prevent the invalid states or confused value roles identified by the supplied domain invariant.", ["representation", "domain invariant", "constructors", "consumers"], ["Partial update and test input types intentionally allow incomplete data"]),
	core_effect: contract("A module explicitly designated as pure must not depend on the ambient effects prohibited by its adopted role policy.", ["role policy", "implementation", "effect dependencies"], ["Declared shell or adapter modules may perform effects"], true),
	module_initialization: contract("Importing a library should not unexpectedly perform external work or acquire unowned runtime resources.", ["module initialization", "entrypoint role", "called helper bodies"], ["Explicit entrypoints bootstrap services", "Pure lookup-table construction is allowed"]),
	resource_ownership: contract("Each acquired resource must have a valid owner and cleanup covering subsequent acquisition and execution failures.", ["acquisitions", "cleanup helpers", "failure paths", "ownership transfers"], ["Explicit ownership transfer or managed lifetime may defer cleanup"]),
	transaction_scope: contract("A transaction should not hold its protected resources across external waits unrelated to its declared atomic operation.", ["transaction semantics", "callback", "called helpers", "atomicity contract"], ["A supplied transaction contract explicitly requires the external operation"]),
	retry_contract: contract("Retries must preserve the explicitly declared replay, atomicity and duplicate-effect behavior.", ["retry contract", "operation", "persistence", "replay or fault-injection evidence"], ["At-least-once delivery is valid when duplicate effects are explicitly accepted"], true),
	secret_flow: contract("A value classified as sensitive by the supplied policy must not reach an unauthorized observable sink.", ["sensitivity policy", "value provenance", "transformations", "sink"], ["A presence boolean, identifier or properly redacted representation is not the credential"], true),
	brand_ownership: contract("Adopted branded values must be constructed only at the boundaries authorized by the construction-owner policy.", ["brand", "construction-owner policy", "constructor or parser", "assertion site"], ["The authorized constructor may live outside the type-definition module"], true),
	documentation: contract("A specific documentation or naming claim must be supported by the supplied implementation and contract.", ["literal claim", "implementation", "relevant callers"], ["A clearly marked example, proposal or future plan is not a claim of current behavior"]),
	api_surface: contract("The supplied public API should expose the capabilities and domain representations its consumers require without unjustified coupling.", ["API", "consumers", "package entrypoints", "boundary policy"], ["Intentional public facades and platform adapters may expose infrastructure types"]),
};

export const FINDING_DISPOSITIONS = ["premise_wrong", "not_applicable", "explicit_exception", "violation", "insufficient_evidence"] as const;
export type FindingDisposition = typeof FINDING_DISPOSITIONS[number];
export type FindingDirection = "concern" | "clear" | "unknown";

export const FINDING_CRITERIA: Record<FindingDisposition, string> = {
	premise_wrong: "The supplied source contradicts the candidate's factual premise.",
	not_applicable: "The factual premise holds, but this invariant does not apply to the supplied scope.",
	explicit_exception: "The premise and scope apply, but evidence establishes an exception listed in the supplied contract or adopted policy.",
	violation: "The supplied evidence establishes a violation of the applicable invariant, with no established listed exception.",
	insufficient_evidence: "The evidence does not establish one of the other outcomes; missing dependencies or policy must not be guessed.",
};

/** Reject prototype keys and unknown rubric names at the input boundary. */
export function findingContract(family: string): FindingContract {
	if (!Object.hasOwn(FINDING_CONTRACTS, family)) throw new Error(`Unknown finding-review family: ${family}`);
	return FINDING_CONTRACTS[family]!;
}

/** Directional agreement intentionally tolerates a different confidence or clear-case rationale. */
export function dispositionDirection(disposition: FindingDisposition): FindingDirection {
	if (disposition === "violation") return "concern";
	return disposition === "insufficient_evidence" ? "unknown" : "clear";
}
