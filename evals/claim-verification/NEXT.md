# Completed decision/graph experiment suite

All six requested pilot areas and the additional final-judge comparison are complete. See [RESULTS-2026-10-20-DECISION-GRAPHS.md](RESULTS-2026-10-20-DECISION-GRAPHS.md); artifacts are under `scratch/2026-10-20-decision-graphs/`.

Jev helped select receipts, attach qualifiers and localize recorded edits in these pilots. Instruction/module graph queries matched or beat models on the tested grammars. The mutation combination with structural diversity found 13 meaningful groups versus 11 for the fixed heuristic, but the plain Jev hybrid found seven. Clef is not a drop-in replacement at the existing final-judge thresholds. Ninety evaluation tests pass; new known API spend is $0.050514382 plus one authentication failure with unknown usage.

No human labels are pending. No production policy, hook activation or model promotion was made. Further claims require prospective sessions and broader modules; the completed controlled and retrospective experiments are not live utility measurements.

# Earlier graph follow-up

Completed offline on October 20; see [RESULTS-2026-10-20.md](RESULTS-2026-10-20.md). One-to-one matching corrects the extraction comparison: 204/666 complete claims for the legacy splitter, 371/666 for the span-preserving splitter, and 21/666 for saved Clairic outputs at IoU ≥0.5. The old scores remain containment diagnostics. One actual receipt replay cannot establish current-state support because the required runtime-input evidence was not captured. Seventy evaluation tests pass; new hosted-model spend is zero.

No live shadow, model comparison, hybrid mutation ranker or production graph was activated. The frozen judgment holdout remains scored once. The next annotation revision should use the claim-unit convention in the new report; no current model labels were silently rewritten.

# Completed trust-run queue

The latest user-authorized run supersedes the archived queue below. Artifacts: `scratch/2026-10-19-claim-verification/trust-run-01/`. No human adjudication is pending. Model labels retain their producer; support accuracy is reported on construction-certified controls and explicit verifier cases, with historical semantic agreement kept descriptive.

| Item | Current result |
| --- | --- |
| Adjudicator controls | Astra 0/656 false endorsements; passes the preset >5% rejection rule on these families only. Deterministic audit: zero support disagreements, 12 unsupported/not-assessable distinctions. |
| Cross-family review | Opus 5.5 completed four messages; weak boundary agreement and missing qualifier fields prevent claiming reliable general labels. |
| Judgment holdout | Scored once. Current 32/32 supported, 1/64 false endorsements; rescue 28/32, 0/64; deterministic-first plus rescue 32/32, 0/64. No production judgment promotion. |
| Receipt shadow | Implemented behind internal `--receipt-shadow LINKS`, default off and log-only. Replay statistics are separate from live traffic, which remains zero. Source skills updated and validated. |
| Mutation ranking | Complete. Final pool: 166 compiler-valid mutants, 93 survivors, 70 killed, 3 timeouts. At 10 seconds per arm, model-adjudicated distinct meaningful groups: heuristic 11, Jev 5, random 4. All 93 survivors labeled blind. The earlier compiler-invalid pool is exploratory only. |
| Clairic | Authentication resolved using existing `cf` OAuth tooling. Four acceptance probes and 50-message extraction completed; same fixed judgment scored 98 evidence cells. Tested schema retained only 24/666 complete reference claims. |
| Independent generative extractor | Authenticated Opus request returned a safety refusal; raw response/cost retained, arm failed rather than scored as zero recall. |

Never rescore `mixed-holdout/` as unseen data. The preset $5 stop applies to known external model cost; collaboration-session billing is not exposed and is never reported as zero. No commit or push. The only permitted harness change remains the optional observer; no hook activation, warning-decision or blocking-policy change is authorized in this run.

**Stop condition reached: queue complete**, including explicit failed-arm reporting for the refused Opus extraction. Known reported external model cost is $2.076606022; Astra session billing is unavailable. Validation: 59 evaluation tests, 28 selected production tests, repository and evaluation typechecks, scoped lint/security checks and both source-skill validators. No production judgment change was adopted. See the final trust-run sections in RESULTS-2026-10-19.md for denominators and limitations.

# Archived completed protocol queue

Objective: execute the six-item queue in the user's attached `pasted-text-1.txt`, with the user's subsequent amendment: the main agent or an independent Astra session adjudicates every result that previously required human semantic review. Evaluation tooling only; no production changes, commits or pushes. Labels are model-adjudicated reference annotations, not human ground truth. Preserve uncertain and missing-evidence outcomes.

## Protocol amendment — agent adjudication

The user explicitly declined human adjudication and authorized Astra reviewers. Two `gpt-6-astra` sessions annotated all 50 complete original messages against both frozen evidence snapshots, blinded to inherited candidate labels and Jev results. A third reviewed five messages independently before reconciliation. The main agent validated spans and receipt identities; the final 666-claim reference set is frozen under `scratch/2026-10-19-claim-verification/reference-snapshot-01/`. No human-label dependency remains. The requested model family is known; its immutable provider revision is not exposed by the collaboration tool.

Jev API calls remain pinned to `jev-1.13.0` and priced per recorded usage. Agent-session dollar cost is not exposed by the collaboration tool and will be reported as unavailable, not zero. No external generative API key is presently available; the independent annotation session is not itself an unbiased extractor arm evaluated against its own labels.

| Item | State | Evidence / next action |
| --- | --- | --- |
| 1. Evidence inventory | Complete | EVIDENCE-INVENTORY.md covers 59/59 registered sources; physical discovery limits and unknown files are explicit. |
| 2. Diagnostic at scale | Complete | 666 reference claims frozen across 50 messages; 196 scored cells on 49 recovered turns. One transport failure retried with identical input. Results expose extraction loss, evidence loss and substantial judgment over-endorsement. |
| 3. Extraction comparison | Complete | Full claim retention 64.0% legacy vs 89.2% span-preserving against model references. Scoped-claim retention remains only 65.7%. External LLM and Clairic arms skipped with reasons. |
| 4. Grounding follow-up | Complete | Independently re-adjudicated development cases; no safe development gain. Frozen one-shot 24-case stress run recovered two positives (6 to 8/12), retaining 0/12 negative endorsements. No population accuracy claim. |
| 5. Deterministic receipt families | Complete | File written, typecheck clean and command completed exercised against actual local receipts; four tests pass, with counterfactual identity/completion probes distinguished. |
| 6. Mutation setup | Complete | Same 13 mutants in both arms; random and heuristic each killed all 13 within the 5-second execution budget. Setup validated, no ranking advantage established. No Jev mutation arms. |

Known goal experiment API spend after item 4: $0.119612682; one transport-failed request has unavailable billing. Agent-session billing is also unavailable. Earlier runs before the attached queue are excluded from this goal's API ledger. Every subsequent API request retains its own usage/cost record.

The former human-adjudication blocker is superseded by the user's amendment above. Clairic still lacks Cloudflare credentials, and no general LLM API key was available in the inspected environment; these are explicit arm skips. They do not stop the remaining authorized work.

The authorized work queue is complete. No production behavior is changed. Further experiments can target evidence capture/linkage and qualifier grouping; promotion into a production judgment or blocking policy requires separate work. The fresh stress suite has been scored once and must not be retuned or rescored as a holdout.

Evidence is frozen under `scratch/2026-10-19-claim-verification/goal-run-01/`. `recovery-reconciliation.json` records 48 exact operational projections and one empty-result/newline-only difference. `labeling-queue-v2.json` adds the scrubbed-anchor recovery while retaining revision 1. Its original zero-cost ledger describes only the pre-amendment phase; current totals include the later logged API calls. All candidate spans, identities and suggested receipt references validate. The large generated Markdown queue exceeded the automatic source-quality size limit; it has no blanket source-quality verdict.

Final validation: 45 evaluation tests pass; the scoped TypeScript check passes; Gitleaks found no leaks in the evaluation directory. `completion-audit.json` verifies frozen source/annotation/evidence hashes, the one-shot holdout chronology and unchanged production module/tests. `goal-model-cost-ledger-final.json` lists all 277 attempted calls and the unknown-cost cases. No production or skill contract changed, and no commit or push was made.
