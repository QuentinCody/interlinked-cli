# Tool-output efficiency lab

This is an opt-in wrapper and an evaluation suite. It does not change native tools,
hooks, or blocking policy. Start with [RESULTS.md](RESULTS.md).

The fixed measurement rule selected mixed outputs from functions.exec. The wrapper
supports that output first, plus file reads, search, test/build logs, structured
JSON, diffs, and historical evidence. Current selection uses exact text blocks.
It does not claim to find complete AST dependency closures.

## Use the wrapper

Run from the repository root. Capture a UTF-8 tool result that already exists:

~~~sh
node --import tsx evals/tool-output-efficiency/cli.mts capture \
  --store evals/tool-output-efficiency/.local/my-session \
  --input /path/to/tool-result.txt \
  --source "tool-call:123" --version "source-revision-or-content-hash" \
  --call-id "123" --category mixed \
  --question "Where is access denied?" --budget-chars 4000
~~~

The default mode uses code only. Add --mode jev to send that supplied output to
TypeSafe using the configured TYPESAFE_API_KEY and pinned jev-1.13.0. This is an
explicit remote call. The local session measurement and replay do not send logs.
Model errors fall back to the declared baseline; inspect the mode in the response.

Without --question, the wrapper returns the supplied --baseline file or a declared
head/tail view. With a question, outputs at or below --min-chars (default 6000)
pass through. --full always returns complete retained text. The selection budget
is UTF-16 characters, not model tokens; evaluation separately measures o200k tokens.
Metadata and required diagnostic blocks can exceed that budget.

~~~sh
node --import tsx evals/tool-output-efficiency/cli.mts expand \
  --store evals/tool-output-efficiency/.local/my-session --id RECEIPT_ID
~~~

Optional --start and --end use end-exclusive UTF-16 offsets. Expansion verifies
the stored content and metadata hash. Use a separate store per agent/session.
Keep the receipt ID when the main context is compacted. If exact edit text,
conditions, or supporting evidence is missing, expand it before proceeding.
“No selected match” does not establish absence. A second read may be necessary.

Pass --complete only when the producer establishes full capture. Without it,
capture completeness is unknown. An intact receipt cannot restore bytes the
original tool omitted. Version labels are caller supplied, not independently
verified repository identities.

Recognized failure words and nonzero exit-code markers are retained conservatively.
These markers can occur in source code and inflate output. They are not a general
test-result parser or proof of execution success. Preserve original runner status
when integrating the wrapper. Unknown formats remain unknown.

## Run the measurements and experiments

Use new output directories. Raw-derived artifacts stay ignored under .local/.

~~~sh
# Reproduce the frozen local cohort; requires retained native transcripts.
python3 -B evals/tool-output-efficiency/measure.py \
  --manifest evals/tool-output-efficiency/.local/run-01/manifest.json \
  --out evals/tool-output-efficiency/.local/new-measurement

# Or freeze a new cohort using a JSON list of {provider,id} parent sessions.
python3 -B evals/tool-output-efficiency/measure.py \
  --parent-ids /path/to/parent-ids.json \
  --out evals/tool-output-efficiency/.local/new-cohort

# Prepare deterministic samples. This copies selected private text locally.
python3 -B evals/tool-output-efficiency/replay.py prepare \
  evals/tool-output-efficiency/.local/run-01 \
  evals/tool-output-efficiency/.local/new-replay

node --import tsx evals/tool-output-efficiency/replay.mts \
  evals/tool-output-efficiency/.local/new-replay/cases.jsonl \
  evals/tool-output-efficiency/.local/new-replay/replayed.jsonl

python3 -B evals/tool-output-efficiency/replay.py summarize \
  evals/tool-output-efficiency/.local/new-replay

# Synthetic controls only: no native transcript submission.
node --import tsx evals/tool-output-efficiency/experiment.mts \
  evals/tool-output-efficiency/.local/new-controls --jev

# Real embeddings plus Jev on the same synthetic controls.
# Uses CLOUDFLARE_API_TOKEN or the existing cf OAuth cache.
node --import tsx evals/tool-output-efficiency/embeddings.mts \
  evals/tool-output-efficiency/.local/new-embedding-controls ACCOUNT_ID

python3 -B -m unittest discover -s evals/tool-output-efficiency -p 'test_*.py'
node --import tsx --test evals/tool-output-efficiency/*.test.mts
node_modules/.bin/tsgo --noEmit -p evals/tool-output-efficiency/tsconfig.json
~~~

Python measurement needs the existing tiktoken package; the pure-helper unit tests
run offline without loading tokenizer tables. No new dependency is installed by
these commands. The first token-counting measurement may fetch tokenizer tables;
later runs use tiktoken's normal cache unless configured otherwise. Transcript content
is never included in those requests. The scan used one process and a disk-backed
hash index, with a measured 536 MB peak resident memory.

## What the experiments can establish

- Native transcripts establish delivered recorded text, subject to native capture
  limits. Interlinked mirrors are not added to native token totals.
- Provider usage is deduplicated by response/message ID. Historical input cost is
  unknown without matching price and billing records.
- Exact normalized line repetition is not proof that a repeated file read is
  unnecessary. Compaction and agents remain separate.
- Later-use matching is a proxy: an eight-word normalized text match, later edit
  to a named file, or exact execution of a command line. Whole blocks are marked
  used conservatively. Commands executed through unsupported wrappers and semantic
  reasoning without quotation may be missed.
- Replay uses tool arguments as a query proxy. It does not invent or establish
  explicit agent intent. It cannot measure task success or real expansion use.
- Code-only JSON projection is available as projectJson in adapters.mts. Embedding
  retrieval accepts actual vectors, validates their shape, and preserves pinned IDs.
- events.jsonl records capture and expansion operations. Re-running a native tool
  outside this wrapper still requires correlation with native logs.
- The synthetic controls put required evidence in the middle on purpose. They test
  retention and recovery, not production relevance accuracy.

Live task trials must measure requests to expand, fresh rereads, missed evidence,
final correctness, total input tokens, actual cost, and peak context separately.
No automatic filtering or repeat suppression is enabled by this lab.
