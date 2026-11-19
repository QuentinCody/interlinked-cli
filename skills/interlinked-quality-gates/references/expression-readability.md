# interlinked-quality-gates: expression readability

Reference for [SKILL.md](../SKILL.md). Read it for `interlinked metrics expressions` or `.interlinked/readability.json`.

### Expression readability is advisory

`interlinked metrics expressions [file-or-directory] --cwd <repo> --json` measures
JS/TS expressions with `interlinked-expression-v1`. A directory scan sets generated, vendored and
minified files aside (source roles v5) and reports them in `population`; a named file is always measured. It reports source hashes, UTF-16
half-open spans, syntax tokens, callback counts/depth and literal-data classification.
Default preferences: tokens >60, callback depth >2, inline callbacks >=3, control-flow
depth >3; nested ternaries, multiline unbraced bodies and same-line sibling statements
also advise. Single-line guards are accepted by default. Generic brace advice defers
to a target's configured style tools; imported rules preserve their explicit policy.
Literal-only tables are excluded from the token warning. Test registration calls are
excluded as containers; computations inside their bodies are still inspected.

Optional `.interlinked/readability.json` is `{ "version": 1, "limits": {
"expressionTokens": 60, "callbackDepth": 2, "callbackCount": 3,
"controlFlowDepth": 3 } }`. Omitted limits keep defaults; unknown fields and invalid
integers are unavailable evidence. The nearest ancestor policy applies, stopping at
the git root. These are calibrated preferences, not protected complexity baselines.
Keep useful domain abstractions and explicit loops even when their branch count rises.
Naming a predicate does not fix discarded provenance or a false success claim.

The command exits 0 for measured inventories, including findings, and 2 for unavailable,
unsupported or empty scope. Directory completeness refers only to listed discovered
JS/TS files. Missing TypeScript or recovery syntax is NOT CHECKED. Hook advice compares
whole expressions against captured pre-edit content, so a change below an unchanged
initializer line is visible; moving or formatting existing debt does not reintroduce it.
Identity uses owner/label and metric-value allowances, not semantic equivalence. Without
a usable before-state the current inventory cannot prove a regression.

Use **interlinked-verify** for `verify --all-checks` and explicit formatter/linter gates.
Do not turn these advisory checks into heuristic `pre_block` errors or lower protected
function/coverage baselines to accommodate formatting.
