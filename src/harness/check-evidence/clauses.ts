// Check Evidence Contract — clause evidence (measured, not enforced; added 2026-10-21).
//
// A detector's header states its contract as clauses: FIRES WHEN (k1) and each DOES NOT FIRE item (k2…). A
// labeled case counts toward `cases` by its title, but a title cannot show that the case would FAIL if its clause
// were removed. E64/E66 measured exactly that gap: in 4 of 4 detectors checked, the negative case that named a
// clause passed whether or not the clause existed, because another exemption already kept the detector quiet.
// Clause evidence comes from recorded faults (requirement id `clause:<module>:k<n>`, run by
// `interlinked tests faults run`): a clause is PINNED when every conclusive fault recorded for it was killed.
// Enforcement is a later ratchet step, like the other dimensions.

import type { FaultOutcome } from "../requirement-faults/corpus.js";

export interface Clause { k: number; direction: "fires" | "quiet"; text: string; }
export interface ClauseRow extends Clause { faults: number; killed: number; fraction: number | null; }
export interface ClauseEvidence { module: string; clauses: ClauseRow[]; total: number; measured: number; pinned: number; }

function section(source: string, label: string): string | null {
    const head = new RegExp(`^//\\s*${label}\\b[^:]*:`); // a "(qualifier)" may sit between the label and its colon
    const lines = source.split("\n"), start = lines.findIndex(line => head.test(line.trimStart()));
    if (start < 0) return null;
    const body = [(lines[start] ?? "").trimStart().replace(head, "")];
    for (const line of lines.slice(start + 1)) {
        const text = line.trimStart();
        if (!text.startsWith("//") || /^\/\/\s*[A-Z][A-Z /-]{2,}(?:\s*\(|:)/.test(text)) break; // next header: "KNOWN GAPS:", "CALIBRATION (…):"
        body.push(text.replace(/^\/\/\s?/, ""));
    }
    return body.join(" ").replace(/\s+/g, " ").trim();
}

const tidy = (text: string) => text.trim().replace(/\.$/, "").replace(/^(?:or|and)\s+/i, "").trim();

/** Header clauses in order; [] unless both FIRES WHEN and DOES NOT FIRE exist. */
export function parseClauses(source: string): Clause[] {
    const fires = section(source, "FIRES WHEN"), section2 = section(source, "DOES NOT FIRE");
    if (fires === null || section2 === null) return [];
    const quiet = section2.split(/\.\s+(?=[A-Z])/)[0] ?? section2; // the list is the first sentence; later sentences are remarks
    const items = quiet.split(quiet.includes(";") ? ";" : ",").map(tidy).filter(Boolean);
    return [{ k: 1, direction: "fires", text: tidy(fires) }, ...items.map((text, n) => ({ k: n + 2, direction: "quiet" as const, text }))];
}

export function clauseEvidence(module: string, clauses: readonly Clause[], outcomes: readonly FaultOutcome[]): ClauseEvidence {
    const rows = clauses.map(clause => {
        const mine = outcomes.filter(row => row.requirement === `clause:${module}:k${clause.k}`);
        const killed = mine.filter(row => row.status === "killed").length, conclusive = killed + mine.filter(row => row.status === "survived").length;
        return { ...clause, faults: mine.length, killed, fraction: conclusive ? killed / conclusive : null };
    });
    return { module, clauses: rows, total: rows.length, measured: rows.filter(row => row.fraction !== null).length, pinned: rows.filter(row => row.fraction === 1).length };
}
