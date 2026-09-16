import type { DiagnosticSnapshot } from "./diagnostic-snapshot.js";

function differences(before: DiagnosticSnapshot, after: DiagnosticSnapshot): string[] {
    const reasons: string[] = [];
    if (before.identity !== after.identity) reasons.push("Measurement profiles, counters or parser versions differ");
    if (!before.complete || !after.complete) reasons.push("At least one snapshot has incomplete measurement scope");
    if (before.discovery !== after.discovery) reasons.push("Source discovery methods differ");
    if (JSON.stringify(before.exclusions) !== JSON.stringify(after.exclusions)) reasons.push("Recorded exclusions differ");
    const population = (snapshot: DiagnosticSnapshot): string => JSON.stringify(snapshot.files.map(file => [file.path, file.language]));
    if (population(before) !== population(after)) reasons.push("Measured path/language populations differ; inspect added and removed files");
    return reasons;
}

function compareRatio(before: DiagnosticSnapshot["verbosity"], after: DiagnosticSnapshot["verbosity"], comparable: boolean) {
    return { before, after, numeratorDelta: comparable ? after.numerator - before.numerator : null,
        denominatorDelta: comparable ? after.denominator - before.denominator : null,
        fractionDelta: comparable && before.fraction !== null && after.fraction !== null ? after.fraction - before.fraction : null,
        dilution: before.fraction !== null && after.fraction !== null && after.fraction < before.fraction && after.numerator >= before.numerator };
}

function fileState(before: DiagnosticSnapshot["files"][number] | undefined, after: DiagnosticSnapshot["files"][number] | undefined): string {
    if (!before) return "added";
    if (!after) return "removed-or-unmeasured";
    return before.hash === after.hash ? "unchanged" : "changed";
}

function compareFiles(before: DiagnosticSnapshot, after: DiagnosticSnapshot) {
    const a = new Map(before.files.map(file => [file.path, file])), b = new Map(after.files.map(file => [file.path, file]));
    return [...new Set([...a.keys(), ...b.keys()])].sort().map(path => {
        const old = a.get(path), current = b.get(path);
        const known = before.identity === after.identity && old !== undefined && current !== undefined && old.language === current.language;
        return { path, state: fileState(old, current), before: old ?? null, after: current ?? null,
            slocDelta: known ? current.sloc - old.sloc : null, flaggedLinesDelta: known ? current.flaggedLines - old.flaggedLines : null };
    });
}

export function compareDiagnosticSnapshots(before: DiagnosticSnapshot, after: DiagnosticSnapshot) {
    const reasons = differences(before, after), comparable = reasons.length === 0;
    return { schemaVersion: 1, comparable, reasons, sourceChanged: before.sourceHash !== after.sourceHash,
        verbosity: compareRatio(before.verbosity, after.verbosity, comparable), erosion: compareRatio(before.erosion, after.erosion, comparable),
        files: compareFiles(before, after), limitations: ["Comparison describes static measurements, not correctness, semantic equivalence or extension effort.",
            "Added, removed or unmeasured files prevent an overall delta; matching-file deltas retain their local scope.",
            "Snapshots are unauthenticated local reports. Hashes bind declared inputs, not the truth of their provenance."] };
}
