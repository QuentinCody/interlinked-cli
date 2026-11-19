# Worked Example: `disk-forensics` → distilled artifacts

This directory shows what `/enforce` emits from a single source skill: the
`disk-forensics` SKILL.md from [`briiirussell/cybersecurity-skills`](https://github.com/briiirussell/cybersecurity-skills).

## Source

`reference-repos/cybersecurity-skills/skills/disk-forensics/SKILL.md`

(Clone the repo to that path to inspect the original. The example below was
derived from commit-of-record by `/enforce` at 2026-05-12.)

## Output artifacts

`/enforce` runs three passes on the source markdown and emits five files:

| File | Tier | Audience | Pass |
|------|------|----------|------|
| `distilled-rules.json` | 1 (deterministic) | Interlinked harness evaluator | 1 |
| `skill-disk-forensics.policy.md` | 2 (LLM gate) | gpt-oss-safeguard-120b prompt context | 2 |
| `skill-disk-forensics.cedar` | — | Drop-in for Sondera's `policies/` dir | 2 |
| `skill-disk-forensics.interlinked.cedar` | — | Interlinked schema extension users | 2 |
| `skipped.report.md` | — | Audit — what `/enforce` chose not to distill | 3 |

## Eleven imperatives, five distilled rules, four skipped

The disk-forensics SKILL.md contains 11 imperatives across its "Evidence
Handling Principles" (L13-18) and "Boundaries" (L141-148) sections.
`/enforce` routes them as follows:

| Source line | Quote (truncated) | Route |
|---|---|---|
| L14 | "Always work on copies, never originals" | distilled-rules.json + Sondera Cedar (P1) |
| L15 | "Verify image integrity ... before analysis" | policy.md + Interlinked Cedar (P3) |
| L16 | "Mount everything read-only" | distilled-rules.json + Sondera Cedar (P2) |
| L17 | "Document every command and finding" | skipped.report.md — no observable signal |
| L18 | "Preserve timestamps — never modify source evidence" | distilled-rules.json + Sondera Cedar (P4); merged with L147 |
| L143 | "Work only on provided images and files" | skipped.report.md — abstract scope |
| L144 | "Maintain read-only access at all times" | merged into L16 rule |
| L145 | "Document chain of custody ..." | skipped.report.md — no trigger |
| L146 | "For CTF challenges, focus on finding flags ..." | skipped.report.md — not imperative |
| L147 | "Never modify evidence or suggest evidence tampering" | merged with L18; intent residue → policy.md (P5) |
| L148 | "Refuse requests involving unauthorized device access" | policy.md (P5, pure intent) |

Net: 3 unique deterministic rules, 5 policy entries (3 mirror deterministic + 2 LLM-only), 4 skipped, 2 merged.

## Why the split

Three of the four "Evidence Handling Principles" map to clean shell-command or
file-path patterns (P1, P2, P4 in the Cedar files) — these become Tier 1
deterministic blocks. One requires session-state awareness (P3 — "verify
before analysis" needs to know whether `sha256sum` ran earlier in the
session); Sondera's vanilla schema can't express it, so it lives in the
`.interlinked.cedar` file and `policy.md` only. The two pure-intent rules
(P5 — refuse tampering, refuse unauthorized device access) have no concrete
regex; they live in `policy.md` only and are evaluated by the LLM Tier 2 gate.

See `../../../skills/enforce/references/companion-artifacts.md` §15 for the routing logic and
`docs/design/interlinked-cedar-extensions.cedarschema` for the schema delta.
