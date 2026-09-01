// ===========================================
// SandboxJob wire contract — cloud runtime-oracle jobs
// ===========================================
// Generalizes the mutation cloud runner (mutation/cloud-runner.ts ships
// {file, overlayContent, overlays} to a Cloudflare Sandbox) into a job runner
// that can carry several deterministic oracle kinds — leak, flake, sanitizer,
// Miri — over the same ChangeSet→Sandbox→run→verdict transport.
//
// SECURITY — no `argv`/`command` on the wire (docs/design/
// overlay-exec-runtime-oracles.md §5, and bun-in-rust.md's rejection of a
// command field). The Worker holds a warm, per-(user,repo) sandbox keyed by
// repo hash and kept across requests. A request that carried a free-form
// command would turn the bearer token from "may run THIS repo's oracle suite"
// into general remote code execution against every warm sandbox — lateral
// movement across tenants. So the client sends a KIND DISCRIMINANT; the Worker
// owns the command table (JOB_TABLE[kind] → {command, reportPath}). The blast
// radius of a stolen token stays exactly what it is for mutation today.

/** The oracle kinds the Worker knows how to run. Extending this is a Worker
 *  deploy (it owns the command table), never a client-supplied command. */
type SandboxJobKind = "mutation" | "leak" | "flake" | "asan" | "miri";

/** A file's full proposed content — the overlay wire shape, primary first.
 *  Identical to mutation's FileOverlay so the transport is shared. */
interface SandboxFileOverlay {
	path: string;
	content: string;
}

/** Risk tier drives which oracles run and how hard (mirrors the pre-push
 *  reviewer triage in multi-agent-pre-push-review.md §3). */
type SandboxRiskTier = "trivial" | "lite" | "full";

/** One job dispatched to the Sandbox Worker. NOTE the absence of any argv /
 *  command / script field — that absence is the security contract, not an
 *  oversight. See the header. */
export interface SandboxJobRequest {
	schemaVersion: 1;
	kind: SandboxJobKind;
	/** Optional repo override; the Worker derives the sandbox id from it. */
	repo?: string;
	sessionId: string;
	/** Full proposed state (primary edit + ChangeSet siblings + companion test). */
	overlays: SandboxFileOverlay[];
	/** The primary edited path, for kinds that mutate/measure one file. */
	file: string;
	/** Client-side budget; the Worker also enforces its own ceiling. */
	timeoutMs: number;
	riskTier: SandboxRiskTier;
}

const VALID_KINDS: ReadonlySet<string> = new Set<SandboxJobKind>([
	"mutation",
	"leak",
	"flake",
	"asan",
	"miri",
]);

/** Every member of `SandboxRiskTier`. Kept adjacent to the type so adding a
 *  tier without admitting it here shows up in one diff. */
const VALID_RISK_TIERS: ReadonlySet<string> = new Set<SandboxRiskTier>([
	"trivial",
	"lite",
	"full",
]);

/**
 * Validate an INBOUND request shape (used Worker-side before dispatch). The
 * load-bearing check is that the request cannot smuggle executable intent:
 * only a known `kind` is honored, and any `command`/`argv`/`script`/`cmd`
 * property makes the request invalid (defense against a client that tries to
 * reintroduce the command channel this contract forbids).
 */
export function isValidSandboxJobRequest(v: unknown): v is SandboxJobRequest {
	if (v === null || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	if (r.schemaVersion !== 1) return false;
	if (typeof r.kind !== "string" || !VALID_KINDS.has(r.kind)) return false;
	// riskTier decides which oracles run and how hard, so an unvalidated one is
	// a privilege question, not a hygiene one: before 2026-08-09 this field was
	// declared required and checked by nothing, so a request could arrive with
	// riskTier absent (or `"trivial "`, or an object) and reach the Worker's
	// triage. Found by the `type_predicate_drift` check.
	if (typeof r.riskTier !== "string" || !VALID_RISK_TIERS.has(r.riskTier)) return false;
	if (typeof r.file !== "string" || typeof r.sessionId !== "string") return false;
	if (typeof r.timeoutMs !== "number" || !Number.isFinite(r.timeoutMs)) return false;
	if (!Array.isArray(r.overlays)) return false;
	for (const o of r.overlays) {
		if (o === null || typeof o !== "object") return false;
		const fo = o as Record<string, unknown>;
		if (typeof fo.path !== "string" || typeof fo.content !== "string") return false;
	}
	// The security invariant: reject any smuggled execution channel.
	for (const forbidden of ["command", "argv", "script", "cmd", "exec", "shell"]) {
		if (forbidden in r) return false;
	}
	return true;
}
