import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { scrubSecrets } from "../secrets.js";
import { hasParseErrors, parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNullable, wireNumber, wireObject, wireString } from "../value-validation.js";
import { findingContract, type FindingContract } from "./finding-contracts.js";
import { digest } from "./store.js";

export interface FindingSource { id: string; file: string; purpose: string; startLine?: number; endLine?: number; revision?: string; symbol?: string; expectedHash?: string; }
export interface FindingPolicy { invariant: string; scope: string; exceptions: string[]; }
export interface FindingCase { id: string; family: string; origin: "detector" | "direct" | "counterexample"; claim: string; sources: FindingSource[]; missing: string[]; policy?: FindingPolicy; }
export interface FindingEvidence { id: string; file: string; purpose: string; revision: string | null; sourceHash: string; startLine: number; endLine: number; text: string; redacted: boolean; }
export interface FindingPacket { id: string; caseId: string; family: string; origin: FindingCase["origin"]; claim: string; contract: FindingContract; policy: FindingPolicy | null; evidence: FindingEvidence[]; missing: string[]; }
export interface FindingBundle { schema: "interlinked.finding-bundle/1"; id: string; packets: FindingPacket[]; }

const policy = wireObject<FindingPolicy>({ invariant: wireString, scope: wireString, exceptions: wireArray(wireString) });
const source = wireObject<FindingSource>({ id: wireString, file: wireString, purpose: wireString, startLine: wireAbsentOptional(wireNumber), endLine: wireAbsentOptional(wireNumber), revision: wireAbsentOptional(wireString), symbol: wireAbsentOptional(wireString), expectedHash: wireAbsentOptional(wireString) });
const candidate = wireObject<FindingCase>({ id: wireString, family: wireString, origin: wireLiteral("detector", "direct", "counterexample"), claim: wireString, sources: wireArray(source), missing: wireArray(wireString), policy: wireAbsentOptional(policy) });
const plan = wireObject({ cases: wireArray(candidate) });
const evidence = wireObject<FindingEvidence>({ id: wireString, file: wireString, purpose: wireString, revision: wireNullable(wireString), sourceHash: wireString, startLine: wireNumber, endLine: wireNumber, text: wireString, redacted: wireBoolean });
const contract = wireObject<FindingContract>({ version: wireLiteral("1"), invariant: wireString, needed: wireArray(wireString), exceptions: wireArray(wireString), requiresPolicy: wireBoolean });
const packet = wireObject<FindingPacket>({ id: wireString, caseId: wireString, family: wireString, origin: wireLiteral("detector", "direct", "counterexample"), claim: wireString, contract, policy: wireNullable(policy), evidence: wireArray(evidence), missing: wireArray(wireString) });
const bundleShape = wireObject<FindingBundle>({ schema: wireLiteral("interlinked.finding-bundle/1"), id: wireString, packets: wireArray(packet) });
const clean = (text: string): string => scrubSecrets(text, { enabled: true }).text;

function unique(ids: string[], label: string): void {
	if (ids.some(id => !/^[\w.-]{1,120}$/.test(id))) throw new Error(`Invalid ${label} identity`);
	if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} identity`);
}

function confined(root: string, file: string): string {
	const absolute = resolve(root, file), rel = relative(root, absolute);
	if (!rel || isAbsolute(file) || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Evidence must be confined to the project");
	if (existsSync(absolute)) {
		const real = relative(root, realpathSync(absolute));
		if (real.startsWith("..") || isAbsolute(real)) throw new Error("Evidence symlink must be confined to the project");
	}
	return absolute;
}

function readSource(root: string, entry: FindingSource): { text: string; revision: string | null } {
	const path = confined(root, entry.file);
	if (entry.revision) {
		if (!/^(?:HEAD|[a-f0-9]{40})$/.test(entry.revision)) throw new Error("Evidence revision must be HEAD or a full commit hash");
		const revision = execFileSync("git", ["rev-parse", "--verify", `${entry.revision}^{commit}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		const text = execFileSync("git", ["show", `${revision}:${entry.file}`], { cwd: root, encoding: "utf8", maxBuffer: 1_000_000, stdio: ["ignore", "pipe", "pipe"] });
		return { text, revision };
	}
	if (statSync(path).size > 1_000_000) throw new Error("source exceeds read budget");
	return { text: readFileSync(path, "utf8"), revision: null };
}

function capture(root: string, entry: FindingSource, missing: string[]): FindingEvidence | null {
	confined(root, entry.file);
	let start = entry.startLine ?? 1;
	validateSelection(entry);
	try {
		const { text, revision } = readSource(root, entry), lines = text.split("\n");
		if (entry.expectedHash && digest(text) !== entry.expectedHash) throw new Error("source changed since discovery");
		let end = entry.endLine ?? lines.length;
		if (entry.symbol) [start, end] = symbolLines(text, entry.file, entry.symbol);
		if (end > lines.length || start > lines.length) throw new Error("source range unavailable");
		const selected = lines.slice(start - 1, end).join("\n");
		if (Buffer.byteLength(selected) > 48_000) throw new Error("source span exceeds evidence budget; select a narrower explicit span");
		const redacted = clean(selected);
		return { id: entry.id, file: entry.file, purpose: clean(entry.purpose), revision, sourceHash: digest(text), startLine: start, endLine: end, text: redacted, redacted: redacted !== selected };
	} catch (error) {
		missing.push(`${entry.id}: unavailable (${error instanceof Error ? clean(error.message).slice(0, 200) : "source read failed"})`);
		return null;
	}
}

function validateSelection(entry: FindingSource): void {
	if (entry.symbol && (entry.startLine !== undefined || entry.endLine !== undefined)) throw new Error("Select a symbol or line range, not both");
	const start = entry.startLine ?? 1;
	if (!Number.isInteger(start) || start < 1) throw new Error("Invalid evidence line range");
	if (entry.endLine !== undefined && (!Number.isInteger(entry.endLine) || entry.endLine < start)) throw new Error("Invalid evidence line range");
}

/** Capture one declaration and its adjacent comments; never choose among duplicate names. */
function symbolLines(text: string, file: string, name: string): [number, number] {
	const parsed = parseTsSource(text, file);
	if (!parsed || hasParseErrors(parsed.sf)) throw new Error("symbol extraction requires complete TypeScript syntax");
	const { ts, sf } = parsed;
	const declarations = sf.statements.filter(node => {
		if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name?.text === name;
		return ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name);
	});
	if (declarations.length !== 1) throw new Error("symbol unavailable or ambiguous");
	const declaration = declarations[0]!;
	let start = declaration.getStart(sf);
	const comments = ts.getLeadingCommentRanges(text, declaration.getFullStart()) ?? [];
	for (const comment of [...comments].reverse()) {
		const gap = text.slice(comment.end, start);
		const lineStart = text.lastIndexOf("\n", comment.pos - 1) + 1;
		if (gap.trim() || (gap.match(/\n/g)?.length ?? 0) > 1 || text.slice(lineStart, comment.pos).trim()) break;
		start = comment.pos;
	}
	return [sf.getLineAndCharacterOfPosition(start).line + 1, sf.getLineAndCharacterOfPosition(declaration.end).line + 1];
}

/** Freeze explicit evidence locally. No inference or network is performed by preparation. */
export function prepareFindingBundle(root: string, value: unknown): FindingBundle {
	if (!plan(value) || value.cases.length > 200) throw new Error("Invalid finding review plan (at most 200 cases)");
	root = realpathSync(root);
	unique(value.cases.map(row => row.id), "case");
	const packets = value.cases.map(row => {
		unique(row.sources.map(entry => entry.id), "evidence");
		if (row.sources.length > 12) throw new Error("At most 12 evidence spans per case");
		const rubric = findingContract(row.family), missing = row.missing.map(clean);
		if (rubric.requiresPolicy && !row.policy) missing.push("adopted policy unavailable");
		const evidence = row.sources.map(entry => capture(root, entry, missing)).filter((entry): entry is FindingEvidence => entry !== null);
		if (Buffer.byteLength(JSON.stringify(evidence)) > 96_000) throw new Error("Case exceeds evidence budget");
		const adopted = row.policy ? { invariant: clean(row.policy.invariant), scope: clean(row.policy.scope), exceptions: row.policy.exceptions.map(clean) } : null;
		const body = { caseId: row.id, family: row.family, origin: row.origin, claim: clean(row.claim), contract: rubric, policy: adopted, evidence, missing };
		return { id: digest(body), ...body };
	});
	const body = { schema: "interlinked.finding-bundle/1" as const, packets };
	return { id: digest(body), ...body };
}

/** Revalidate retained evidence before any inference; identities bind exactly the supplied packet. */
export function parseFindingBundle(value: unknown): FindingBundle {
	if (!bundleShape(value) || value.packets.length > 200) throw new Error("Invalid finding bundle");
	unique(value.packets.map(row => row.caseId), "case");
	const { id, ...body } = value;
	if (digest(body) !== id) throw new Error("Finding bundle identity mismatch");
	for (const row of value.packets) {
		const { id: packetId, ...packetBody } = row;
		if (digest(packetBody) !== packetId || digest(row.contract) !== digest(findingContract(row.family))) throw new Error("Finding packet identity or contract mismatch");
		validateEvidenceBounds(row);
	}
	return value;
}

function validateEvidenceBounds(packet: FindingPacket): void {
	unique(packet.evidence.map(row => row.id), "evidence");
	if (packet.evidence.length > 12 || Buffer.byteLength(JSON.stringify(packet)) > 110_000) throw new Error("Finding packet exceeds evidence budget");
	for (const row of packet.evidence) {
		if (Buffer.byteLength(row.text) > 48_000) throw new Error("Source span exceeds evidence budget");
		if (!Number.isInteger(row.startLine) || row.startLine < 1 || !Number.isInteger(row.endLine) || row.endLine < row.startLine || !/^[a-f0-9]{64}$/.test(row.sourceHash)) throw new Error("Invalid evidence provenance");
		if (row.revision !== null && !/^[a-f0-9]{40}$/.test(row.revision)) throw new Error("Invalid pinned revision");
	}
}
