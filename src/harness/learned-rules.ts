// ===========================================
// Cross-Session Learned Rules
// ===========================================
// Persists observed proposals in learned-rules.json only. No guard/settings
// writer or evaluator consumes this store as authorization. The historical
// decision: "allow" field describes a proposal, not effective permission.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LearnedRule } from "./types.js";

const LEARNED_RULES_FILE = "learned-rules.json";
const DEFAULT_THRESHOLD = 5;

/** In-memory observation counts for the current process lifetime */
const _observations = new Map<string, { count: number; first_seen: string }>();

export interface LearnedRulesStore {
	/** All persisted learned rules */
	rules: LearnedRule[];
	/** Check if a pattern has been learned (fast lookup) */
	has(pattern: string): boolean;
	/** Record an observation of a pattern. Returns the rule if threshold was crossed. */
	observe(pattern: string, sessionId: string): LearnedRule | null;
	/** Persist to disk */
	save(): void;
	/** Load from disk */
	load(): void;
}

/** Create a learned rules store rooted at the given .interlinked directory */
export function createLearnedRulesStore(
	interlinkedDir: string,
	threshold?: number,
): LearnedRulesStore {
	const filePath = join(interlinkedDir, LEARNED_RULES_FILE);
	const learnThreshold = threshold ?? DEFAULT_THRESHOLD;
	let rules: LearnedRule[] = [];
	const ruleSet = new Set<string>();

	const store: LearnedRulesStore = {
		get rules() {
			return rules;
		},

		has(pattern: string): boolean {
			return ruleSet.has(pattern);
		},

		observe(pattern: string, sessionId: string): LearnedRule | null {
			if (ruleSet.has(pattern)) return null;

			const now = new Date().toISOString();
			const existing = _observations.get(pattern);
			const count = existing ? existing.count + 1 : 1;
			const firstSeen = existing?.first_seen ?? now;

			if (count >= learnThreshold) {
				const rule: LearnedRule = {
					pattern,
					observation_count: count,
					decision: "allow",
					first_seen: firstSeen,
					learned_at: now,
					learned_in_session: sessionId,
				};
				rules.push(rule);
				ruleSet.add(pattern);
				_observations.delete(pattern);
				store.save();
				return rule;
			}

			_observations.set(pattern, { count, first_seen: firstSeen });
			return null;
		},

		save(): void {
			try {
				if (!existsSync(interlinkedDir)) {
					mkdirSync(interlinkedDir, { recursive: true });
				}
				writeFileSync(filePath, `${JSON.stringify(rules, null, 2)}\n`);
			} catch (e) {
				void e;
			}
		},

		load(): void {
			try {
				if (existsSync(filePath)) {
					const data = JSON.parse(readFileSync(filePath, "utf-8"));
					if (Array.isArray(data)) {
						rules = data;
						ruleSet.clear();
						for (const r of rules) ruleSet.add(r.pattern);
					}
				}
			} catch (e) {
				void e;
			}
		},
	};

	store.load();
	return store;
}
