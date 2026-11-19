import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceLanguage } from "./inventory-roles.js";
import { emptyEvidenceCounts, type RepositoryInventory, type RoleEvidence, type RoleEvidenceKind, type SourceRole } from "./measurement-types.js";
import { classifyByPath, countLines } from "./role-evidence.js";

export const MAX_DECLARED_LISTED = 50;
const LARGEST_LISTED = 5;
const MAX_READ_BYTES = 16 * 1024 * 1024;

export interface EvidenceEntry { path: string; role: SourceRole; from: SourceRole | null; lines: number | null; evidence: RoleEvidence; }
export interface RoleRow { role: SourceRole; files: number; lines: number | null; }
export interface SetAside {
	files: number; lines: number | null; byKind: Record<RoleEvidenceKind, number>;
	largest: EvidenceEntry[];
}
/** A product file whose own header says it is generated. It stays measured: an agent can write that header. */
export interface DeclaredEntry { path: string; lines: number; detail: string; }
export interface ProvenanceSummary {
	schemaVersion: 1; rolesVersion: string;
	authored: { files: number; lines: number };
	roles: RoleRow[];
	/** `unlinted`: the repository's own linter configuration excludes these paths. It is not a claim that a generator wrote them. */
	setAside: { generated: SetAside; vendor: SetAside; unlinted: SetAside };
	/** Every file that evidence beyond the path-only role moved out of its path-only role (product or test). */
	moved: { total: number; byKind: Record<RoleEvidenceKind, number>; toRole: Record<string, number> };
	declared: { total: number; listed: number; files: DeclaredEntry[] };
	line: string;
}

const emptyKinds = emptyEvidenceCounts;

/** Lines of one excluded source file, read only for the report and only within a size bound. */
function readLines(root: string, path: string): number | null {
	if (sourceLanguage(path) === null) return null;
	try {
		const absolute = join(root, path), stat = lstatSync(absolute);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_READ_BYTES) return null;
		return countLines(readFileSync(absolute, "utf8"));
	} catch { return null; }
}

function sum(values: readonly (number | null)[]): number | null {
	const known = values.filter((value): value is number => value !== null);
	return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

function entries(inventory: RepositoryInventory): EvidenceEntry[] {
	return inventory.excluded.map(file => ({ path: file.path, role: file.role, from: file.from ?? null,
		lines: file.lines ?? (file.role === "generated" || file.role === "vendor" || file.role === "unlinted" ? readLines(inventory.root, file.path) : null),
		evidence: file.evidence ?? classifyByPath(file.path).evidence ?? { kind: "path", detail: file.role } }));
}

function bySize(a: EvidenceEntry, b: EvidenceEntry): number {
	return (b.lines ?? -1) - (a.lines ?? -1) || a.path.localeCompare(b.path);
}

function setAside(all: readonly EvidenceEntry[], role: SourceRole): SetAside {
	const rows = all.filter(entry => entry.role === role).sort(bySize), byKind = emptyKinds();
	for (const row of rows) byKind[row.evidence.kind]++;
	return { files: rows.length, lines: sum(rows.map(row => row.lines)), byKind, largest: rows.slice(0, LARGEST_LISTED) };
}

function roleRows(inventory: RepositoryInventory, all: readonly EvidenceEntry[]): RoleRow[] {
	const rows = new Map<SourceRole, (number | null)[]>();
	for (const file of inventory.files) rows.set(file.role, [...rows.get(file.role) ?? [], countLines(file.content)]);
	for (const entry of all) rows.set(entry.role, [...rows.get(entry.role) ?? [], entry.lines]);
	return [...rows].map(([role, lines]) => ({ role, files: lines.length, lines: sum(lines) })).sort((a, b) => a.role.localeCompare(b.role));
}

function movedSummary(inventory: RepositoryInventory, all: readonly EvidenceEntry[]): ProvenanceSummary["moved"] {
	const moved = { total: 0, byKind: emptyKinds(), toRole: {} as Record<string, number> };
	const count = (role: SourceRole, kind: RoleEvidenceKind): void => { moved.total++; moved.byKind[kind]++; moved.toRole[role] = (moved.toRole[role] ?? 0) + 1; };
	for (const entry of all) if (entry.from !== null) count(entry.role, entry.evidence.kind);
	for (const file of inventory.files) if (file.moved !== undefined) count(file.role, file.moved.evidence.kind);
	return moved;
}

function summaryLine(authored: number, declared: number, buckets: ProvenanceSummary["setAside"], inventory: RepositoryInventory): string {
	const header = declared > 0 ? ` (${declared} declare generated, still measured)` : "";
	const parts = [`authored ${authored} files${header}`, `generated ${buckets.generated.files}`, `vendored ${buckets.vendor.files}`, `unlinted ${buckets.unlinted.files}`];
	const other = new Map<string, number>();
	for (const file of inventory.files) if (file.moved !== undefined) {
		const key = `moved to ${file.role} by ${file.moved.evidence.kind === "tool-path" ? "tool path" : file.moved.evidence.kind}`;
		other.set(key, (other.get(key) ?? 0) + 1);
	}
	for (const [key, count] of other) parts.push(`${key} ${count}`);
	return parts.join(" · ");
}

/** What the metrics measured as authored, and what they set aside as generated or vendored, with the evidence for each. */
export function summarizeProvenance(inventory: RepositoryInventory): ProvenanceSummary {
	const all = entries(inventory), products = inventory.files.filter(file => file.role === "product");
	const buckets = { generated: setAside(all, "generated"), vendor: setAside(all, "vendor"), unlinted: setAside(all, "unlinted") };
	const declared = products.filter(file => file.declaredGenerated !== undefined)
		.map(file => ({ path: file.path, lines: countLines(file.content), detail: file.declaredGenerated?.detail ?? "" }))
		.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
	return { schemaVersion: 1, rolesVersion: inventory.version,
		authored: { files: products.length, lines: products.reduce((total, file) => total + countLines(file.content), 0) },
		roles: roleRows(inventory, all), setAside: buckets, moved: movedSummary(inventory, all),
		declared: { total: declared.length, listed: Math.min(declared.length, MAX_DECLARED_LISTED), files: declared.slice(0, MAX_DECLARED_LISTED) },
		line: summaryLine(products.length, declared.length, buckets, inventory) };
}
