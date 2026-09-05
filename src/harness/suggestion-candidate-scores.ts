import type { Finding } from "./suggestion-scorer.js";
interface CandidateScore { score: number; suppressed: boolean; }
const scores = new WeakMap<Finding, CandidateScore>();
export function rememberCandidateScore(finding: Finding, score: CandidateScore): void { scores.set(finding, score); }
export function candidateScore(finding: Finding): CandidateScore | undefined { return scores.get(finding); }
