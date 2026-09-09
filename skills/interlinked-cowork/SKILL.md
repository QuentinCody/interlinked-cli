---
name: interlinked-cowork
description: "Package, test, and operate the experimental Interlinked Cowork plugin. Use for Claude Desktop versus Cowork hook gaps, cowork package/capabilities/probe-prompt/report/bridge/verify/artifact, cloud versus device versus host paths, native conformance evidence, and hook runtime failures."
---

# Interlinked Cowork

Cowork uses an uploaded plugin, separately from Claude Code settings. Ordinary Desktop Chat supports plugin skills but does not expose Cowork's hooks. Do not run `enable --clients cowork`; use `interlinked cowork package --output <fresh-directory>` and upload the resulting `.plugin` in Desktop Customize → Plugins. Requires the built standalone runtime, Node in the hook environment, and `zip` on the packaging host. After replacement, verify the displayed version/hooks and start a fresh task.

## Native evidence and limitations

Run `interlinked cowork capabilities --json`. Dated native evidence is distinct from the current installation, which remains unmeasured until probed. On Desktop 1.49585.0 cloud mode, native deny, ask, input rewrite, and post-tool context were observed. Hook crashes and provider timeouts allowed synthetic writes. The guard launcher converts child failures, missing Node, and a 12-second internal deadline to explicit denial before the 15-second native deadline. If the provider never launches or kills the entire hook, this wrapper cannot enforce anything.

The ordinary plugin installs six lifecycle/tool hooks. A separate `--probe` package registers the larger Claude Code event catalog, including failure/subagent events, to measure availability; registration does not establish emission or enforcement. Keep fault injection confined to synthetic tasks, then disable the probe plugin. Do not retry denied actions through another tool.

Normal PostToolUse hooks match only Write, Edit, MultiEdit, NotebookEdit, Bash and the exact device Bash tool; reads/searches and unrelated connector tools do not trigger them. Probe subscriptions remain broad. Host guidance is encoded in PreToolUse `additionalContext`, including ordinary allows without a permission override; post-write artifact feedback is appended to host findings. Receipts still exclude guidance text. Pre-tool context delivery on the current native installation needs its own probe; local encoder tests are not native enforcement evidence.

```bash
interlinked cowork package --probe --output scratch/cowork-probe-1
interlinked cowork probe-prompt
interlinked cowork report events.jsonl --effects listing.txt
```

Run the prompt through the native Cowork task UI; invoking the hook yourself is a unit test, not native evidence. Verify a clean synthetic directory first. Export `evidence/events.jsonl` and an independent listing containing `PRESENT filename` / `ABSENT filename` lines. Choose **Download**, rather than **Download and open**, for JSONL. The report refuses repeated campaigns and requires a positive control. Listing provenance, matching package/version/session and UI approval evidence still need review.

Receipts are metadata/hash-only with policy digest and native payload key names. They precede hook output: even an intended denial does not prove emission. They are not full transcripts, authenticated writer attribution, lossless session capture, or a substitute for effect evidence. Keep exports local unless sharing is authorized.

## Policy and host checks

Policy JSON: `{"schema":1,"mode":"guard","deniedTools":[],"deniedPaths":[]}`. Tool denials match exact native names. Paths match exact normalized native Read/Write/Edit targets, not arbitrary strings in tool content. The shared destructive-command guard handles Bash and `mcp__remote-devices__device_bash`. Unknown tool semantics, shell filesystem effects, browser/computer actions, connector mutations and device stage/commit remain unmeasured unless separately tested. This portable subset does not inherit repository reservations, distilled rules, supply-chain allowlists or metric baselines by itself.

Host distilled/finding rules may scope `active_when.agent_source` to `"cowork"`, alone or in an array. Both runtime loaders preserve that scope; it requires the host bridge to reach the repository evaluator.

Optional `bridge`: `{ "url":"https://your-host/hook", "tokenEnv":"INTERLINKED_COWORK_TOKEN", "workspace":"project", "timeoutMs":5000 }`. Credentials stay in environment variables, never in the archive. Cloud credential provisioning and public HTTPS reachability require a separate operational deployment; local loopback is not reachable from a cloud hook. The Interlinked MCP Server is a separate optional coordination service, not this bridge.

```bash
interlinked cowork bridge --workspace project --root /host/project --runtime-root /native/project --token-env INTERLINKED_COWORK_TOKEN
interlinked cowork verify /host/project
interlinked cowork artifact /path/report.xlsx
```

The bridge binds loopback and requires a token of at least 32 characters. It accepts only explicit Read/Write/Edit targets inside the configured workspace; realpath confinement rejects symlink escapes. Native and host snapshots must agree and remain stable during evaluation. A snapshot is not a lock, authenticated writer identity, or proof of a shared mount. Unknown routes/tools, mismatched bytes, unavailable daemon/credentials and busy checks produce no allow. Host ask decisions remain native permission requests; host input rewrites conservatively deny because host-to-native path translation is not certified. Do not expose the listener directly; use an explicitly configured authenticated HTTPS deployment if needed.

`cowork verify` runs tsc, biome and gitleaks and compares workspace input hashes before/after. Skipped or changed inputs remain unmeasured and exit nonzero. It does not run every quality ratchet: use **interlinked-verify** and **interlinked-quality-gates** on the actual repository for configured tests, coverage, mutation, baselines and full checks.

`cowork artifact` checks files up to 32 MiB: bounded Office ZIP/XML parts, cached spreadsheet error markers, heuristic placeholder text and credential patterns. Native Write post-hooks also inspect supported artifacts when bytes are accessible. XML schema/CRC validity, macro safety, formula calculation, factual/citation accuracy, visual rendering and publishing authority are outside this check. Error findings or unsupported formats exit nonzero; warnings require contextual review. See `docs/cowork.md` for the measured matrix and deployment gaps.
