// interlinked-tdd: exempt
// Semantic graph — the shared contract. Types only.
//
// A semantic graph is a set of typed EDGES between code UNITS, each edge judged
// by a decision model as a bounded CHOICE among deterministic candidates. The
// decision model ranks and proposes; it never gates (research digest
// research/DIGEST-semantic-graph-2026-10-25.md §4: ranking AUROC .86–.97,
// fixed thresholds did not transfer). A Haiku confirmation pass covers only the
// top slice. Nothing here sits in the check pipeline or `interlinked verify`
// (feedback_harness_deterministic_only).

/** What a unit is. `doc_comment` = the JSDoc/comment block directly above a
 *  function; `test` = one it()/test() block; `doc_section` = one markdown
 *  heading with its body. */
export type UnitKind = "function" | "doc_comment" | "test" | "doc_section";

export interface Unit {
	/** `<file>#<kind>:<qualifiedName or heading>@<line>` — stable across commits while the location is. */
	id: string;
	kind: UnitKind;
	/** Repo-relative, forward slashes. */
	file: string;
	/** Function qualified name, test title, or heading text. */
	name: string;
	line: number;
	endLine: number;
	/** The unit's own text, what a packet carries. */
	text: string;
	/** sha256 of `text`, the identity used for staleness. */
	hash: string;
}

/** Deterministic candidate generators. Every rule names units of the target kind. */
export type CandidateRule =
	| "same_file"
	| "import_edge"
	| "name_match"
	| "co_change"
	| "companion";

/** One row of `.interlinked/semantic-relationships.json`. */
export interface RelationshipType {
	/** Edge type name; `promises`, `pins`, `constrains`, `supersedes`, or your own. */
	name: string;
	description: string;
	source_kind: UnitKind;
	target_kind: UnitKind;
	/** The question Jev answers as a Choice among candidates plus `none`. */
	question: string;
	/** What `none` means for this type. */
	none_description: string;
	/** Ordered rules; candidates are taken in this order until `k` is reached. */
	candidate_rules: CandidateRule[];
	/** Candidates per source unit (2..12). */
	k: number;
}

/** Repo-relative globs bounding unit extraction; an absent field takes the seed default. */
export interface ScopeConfig {
	include?: string[];
	exclude?: string[];
}

export interface RelationshipsFile {
	version: 1;
	scope?: ScopeConfig;
	relationships: RelationshipType[];
}

export type EdgeState = "proposed" | "confirmed" | "contradicted" | "stale";

/** One judged packet: a source unit against its candidate set. */
export interface Edge {
	type: string;
	source: string;
	/** Chosen target unit id, or null when the model chose `none`. */
	target: string | null;
	/** Probability of the chosen target (or of `none`). */
	p: number;
	/** Full distribution over candidate ids plus `none`. */
	probabilities: Record<string, number>;
	confidence: number;
	/** Candidate ids in the order presented. */
	candidates: string[];
	/** sha256 over source text, candidate texts, question, model, and PACKET_VERSION. */
	packet_hash: string;
	source_hash: string;
	model: string;
	judged_at: string;
	state: EdgeState;
	/** Set by the confirmation pass. */
	confirmation?: Confirmation;
}

export interface Confirmation {
	model: string;
	verdict: "supported" | "contradicted" | "undecided";
	/** A quote from the target or source text that carries the verdict. */
	evidence: string;
	confirmed_at: string;
}

/** Bump when the packet layout or the question wrapper changes; invalidates every hash. */
export const PACKET_VERSION = "semantic-packet-v1";

export const SEMANTIC_GRAPH_DIR = ".interlinked/semantic-graph";
export const EDGES_FILE = "edges.jsonl";
export const UNITS_FILE = "units.json";
export const RELATIONSHIPS_FILE = ".interlinked/semantic-relationships.json";

/** Four metrics per relationship type, each a count with its denominator. */
export interface TypeMetrics {
	type: string;
	/** Source units with no edge of this type (`target === null` or no packet). */
	orphans: { count: number; of: number };
	/** Confirmed-pass edges judged `contradicted`, over edges that were confirmed. */
	mismatches: { count: number; of: number };
	/** Edges with a target whose two files share no import edge in either direction. */
	hidden_coupling: { count: number; of: number };
	/** Edges whose `p` moved by more than the noise floor since the previous judgment of the same packet, over re-judged edges. */
	churn: { count: number; of: number };
}

/** p95 |Δp| on identical repeats (staleness replay 2026-10-26); not a gate, a reporting floor. */
export const CHURN_NOISE_FLOOR = 0.06;
