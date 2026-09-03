// FactSite + representativeSites — the bounded declared-fact-drift slicer
// behind SpecLedger.declaredFactDrift (line-cap split of ledger.ts).

export type FactSite = { file: string; line: number; value: string };

/** Representative slices for bounded declared-fact-drift output (sol-max #5):
 *  `summary` is one site per DISTINCT VALUE (so every contradicting value shows);
 *  `findings` lists those value-representative files FIRST, then fills with other
 *  disagreeing files up to `findingCap` — so the contradictory value/file always
 *  survives the cap even behind a long run of an agreeing value, while still
 *  emitting one finding per involved file when they fit. */
export function representativeSites(
	list: FactSite[],
	findingCap: number,
	pinFile?: string,
): { summary: FactSite[]; findings: FactSite[] } {
	const perValue = new Map<string, FactSite>();
	for (const s of list) {
		if (!perValue.has(s.value)) perValue.set(s.value, s);
	}
	const summary = [...perValue.values()];
	const findings: FactSite[] = [];
	const seen = new Set<string>();
	const take = (s: FactSite | undefined): void => {
		if (s && !seen.has(s.file) && findings.length < findingCap) {
			seen.add(s.file);
			findings.push(s);
		}
	};
	// scoped file first so a scoped query never drops it (sol-max #6); then one per
	// distinct VALUE; then fill by file — all bounded by findingCap (sol-max #12).
	if (pinFile) take(list.find((s) => s.file === pinFile));
	for (const s of summary) take(s);
	for (const s of list) take(s);
	return { summary, findings };
}
