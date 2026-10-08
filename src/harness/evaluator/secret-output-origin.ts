// ===========================================
// Secret-shaped Bash output: classify the ORIGIN before ratcheting
// ===========================================
// The Bash output scan used to raise the WHOLE session to Confidential on any
// secret-signature hit. In session c698b9a9 an agent ran
// `rg -o '"INNERTUBE_API_KEY":"[^"]+"' yt_watch_X.html` on YouTube pages it had
// just downloaded; YouTube's public web-client key matched sig-secret-gcp-api
// and every network call of every agent was then hard-blocked. Bytes fetched
// from the public internet are not confidential: sending them out again
// leaks nothing private.
//
// Three outcomes, decided per hit:
//   fetched        — every byte the command printed came from a public,
//                    unauthenticated fetch (the command itself, or files the
//                    session recorded as fetched and that are unchanged since).
//                    Level unchanged; an audit source at Public is recorded.
//   public-context — every occurrence sits inside a registered public-credential
//                    context (public-credential-contexts.ts). Level → Internal.
//   local          — anything else, including every shape not modeled. Level →
//                    Confidential, exactly as before.

import { publicContextsCovering } from "../public-credential-contexts.js";
import type { SignatureMatch } from "../signatures.js";
import { scanSecrets } from "../signatures.js";
import { ratchetActorSensitivity } from "../taint-tracker.js";
import type {
	HarnessEvent,
	SensitivityLevel,
	SessionTrajectory,
	TaintTrackingConfig,
} from "../types.js";
import {
	boundVariables,
	commandHead,
	expandArgv,
	hasUnresolvedVar,
	type Pipeline,
	splitPipelines,
	type Stage,
} from "./bash-stage-parse.js";
import { externalOriginOf, redactedExcerpt } from "./external-origin-files.js";
import { type PublicFetch, publicFetchOf } from "./public-fetch-stage.js";
import { CONTROL_HEADS, filterInputs, type OperandContext, stageInputFiles } from "./stage-operands.js";
import { readToolString } from "./tool-input-values.js";

export type SecretOrigin =
	| { kind: "fetched"; origin: string }
	| { kind: "public-context"; contexts: string[] }
	| { kind: "committed-fixture" }
	| { kind: "local" };

type OriginContext = OperandContext & { session: SessionTrajectory };

export const SECRET_ADVICE = "Do NOT include these in subsequent messages or file writes.";
const ADVICE = SECRET_ADVICE;

function externalSources(session: SessionTrajectory, files: readonly string[] | null): string[] | null {
	if (files === null) return null;
	const sources: string[] = [];
	for (const f of files) {
		const entry = externalOriginOf(session, f);
		if (!entry) return null;
		sources.push(entry.source);
	}
	return sources;
}

/** echo / printf of literal text that itself carries no secret. */
function isInertEcho(argv: readonly string[]): boolean {
	const args = argv.slice(1);
	return args.every((t) => !hasUnresolvedVar(t)) && scanSecrets(args.join(" ")).length === 0;
}

/** A public fetch prints only fetched bytes, provided it is the producer and
 *  reads no local file (`-d @creds.json` would echo back through some servers). */
function fetchStageOrigins(ctx: OriginContext, stage: Stage, argv: readonly string[], fetch: PublicFetch): string[] | null {
	const sources = externalSources(ctx.session, stageInputFiles(ctx, stage, argv, new Set(fetch.consumed)));
	return sources === null ? null : [fetch.url, ...sources];
}

/** Origins of the bytes one stage prints, or null when they may be local. */
function stageOrigins(ctx: OriginContext, stage: Stage, argv: readonly string[], first: boolean): string[] | null {
	const head = commandHead(argv[0]);
	if (argv.length === 0 || CONTROL_HEADS.has(head)) return first ? [] : null;
	if (head === "echo" || head === "printf") return first && isInertEcho(argv) ? [] : null;
	const fetch = publicFetchOf(stage.text, argv);
	if (fetch) return first ? fetchStageOrigins(ctx, stage, argv, fetch) : null;
	const files = filterInputs(ctx, stage, argv);
	if (first && files?.length === 0) return null;
	return externalSources(ctx.session, files);
}

function pipelineOrigins(ctx: OriginContext, p: Pipeline, vars: ReadonlyMap<string, string[]>): string[] | null {
	const origins: string[] = [];
	for (const [i, stage] of p.stages.entries()) {
		const argvs = stage.dynamic ? null : expandArgv(stage.argv, vars);
		if (!argvs) return null;
		for (const argv of argvs) {
			const found = stageOrigins(ctx, stage, argv, i === 0);
			if (found === null) return null;
			origins.push(...found);
		}
	}
	return origins;
}

/** Public origins of everything the command printed, or null when any part may be local. */
function fetchedOrigins(command: string, cwd: string, session: SessionTrajectory): string[] | null {
	const pipelines = splitPipelines(command);
	const vars = boundVariables(pipelines);
	const ctx: OriginContext = { command, cwd, session };
	const origins: string[] = [];
	for (const p of pipelines) {
		const found = pipelineOrigins(ctx, p, vars);
		if (found === null) return null;
		origins.push(...found);
	}
	return origins.length > 0 ? origins : null;
}

function summarizeOrigins(origins: readonly string[]): string {
	const unique = [...new Set(origins.map(redactedExcerpt))];
	const shown = unique.slice(0, 2).join(", ");
	return unique.length > 2 ? `${shown} (+${unique.length - 2} more)` : shown;
}

/** What is known about where secret-shaped bytes came from. The probes are
 *  lazy and run in order; the first that holds decides. */
export interface SecretOriginEvidence {
	/** The scanned text. */
	text: string;
	ruleIds: readonly string[];
	/** Public origins of EVERY scanned byte (non-empty), or null when any byte may be local. */
	fetchedOrigins: () => readonly string[] | null;
	/** Read tool only: the values are committed test data (committed-test-fixture.ts). */
	committedFixture?: () => boolean;
}

/**
 * THE origin decision for a secret-signature hit, shared by the Bash output
 * scan and the Read output scan: fetched ⇒ public; every occurrence in a
 * registered public-credential context ⇒ Internal; committed test fixture
 * (Read only) ⇒ Internal; anything else ⇒ local (Confidential).
 */
export function classifySecretOrigin(e: SecretOriginEvidence): SecretOrigin {
	const origins = e.fetchedOrigins();
	if (origins) return { kind: "fetched", origin: summarizeOrigins(origins) };
	const contexts = publicContextsCovering(e.text, e.ruleIds);
	if (contexts) return { kind: "public-context", contexts };
	return e.committedFixture?.() === true ? { kind: "committed-fixture" } : { kind: "local" };
}

export interface SecretTaintTarget {
	session: SessionTrajectory;
	taint: TaintTrackingConfig;
	/** Pseudo-file the taint source names: `<command-output>`, `<read>`. */
	sourceFile: string;
	/** Where the value was seen: "from `cmd`", "in /path". */
	where: string;
	/** The actor whose output this is (`actorKeyOf`). It and its ancestors
	 *  ratchet; concurrent siblings do not (taint-lineage.ts). Undefined ⇒ the
	 *  legacy session-wide ratchet. */
	actor?: string | undefined;
}

/** Apply a classified hit's taint effect: an audit source (fetched), Internal
 *  (public context, committed fixture) or Confidential (local). */
export function applySecretOrigin(t: SecretTaintTarget, origin: SecretOrigin, idList: string): void {
	const { session, taint, actor } = t;
	const ratchet = (level: SensitivityLevel, detail: string): void => {
		ratchetActorSensitivity(session, actor, { file: t.sourceFile, level, detail }, taint);
	};
	if (origin.kind === "fetched") {
		session.taint_sources.push({
			file: `${t.sourceFile.replace(/>$/, "")}:public-origin>`,
			level: "Public",
			at_step: session.tool_call_count,
			provenance: "fetched_external",
			detail: `${idList} fetched from ${origin.origin}`,
		});
		return;
	}
	if (origin.kind === "public-context") {
		ratchet("Internal", `${idList} in public-credential context (${origin.contexts.join(", ")}) ${t.where}`);
		return;
	}
	if (origin.kind === "committed-fixture") {
		ratchet("Internal", `${idList} (committed test fixture) ${t.where}`);
		return;
	}
	ratchet("Confidential", `${idList} ${t.where}`);
}

export interface SecretOutputScan {
	event: HarnessEvent;
	session: SessionTrajectory | undefined;
	taint: TaintTrackingConfig | undefined;
	/** The scanned output slice. */
	text: string;
	matches: readonly SignatureMatch[];
	/** `actorKeyOf` of the actor that ran the command. */
	actor?: string | undefined;
}

/** Classify a Bash secret-signature hit, apply its taint effect, and return
 *  the `[interlinked:output-scan]` warning line. */
export function applySecretOutputTaint(scan: SecretOutputScan): string {
	const ids = scan.matches.map((m) => m.rule_id);
	const idList = ids.join(", ");
	const legacy = `[interlinked:output-scan] Secrets detected in command output: ${idList}. ${ADVICE}`;
	const { session, taint } = scan;
	if (!session || !taint?.enabled) return legacy;
	const command = readToolString(scan.event.tool_input?.command);
	const cwd = scan.event.cwd || process.cwd();
	const origin = classifySecretOrigin({
		text: scan.text,
		ruleIds: ids,
		fetchedOrigins: () => (command.trim() === "" ? null : fetchedOrigins(command, cwd, session)),
	});
	const where = `from \`${redactedExcerpt(command)}\``;
	applySecretOrigin({ session, taint, sourceFile: "<command-output>", where, actor: scan.actor }, origin, idList);
	if (origin.kind === "fetched") {
		return `[interlinked:output-scan] secret-shaped value (${idList}) in content fetched from ${origin.origin} — treated as public; session sensitivity unchanged. ${ADVICE}`;
	}
	if (origin.kind === "public-context") {
		return `[interlinked:output-scan] secret-shaped value (${idList}) sits in a documented public-credential context (${origin.contexts.join(", ")}) — session sensitivity raised to Internal, not Confidential. ${ADVICE}`;
	}
	return legacy;
}
