# interlinked-verify: e2e lane for Interlinked CLI boundary edits

Reference for [SKILL.md](../SKILL.md). This applies only in the Interlinked CLI source checkout.

### E2E lane for Interlinked CLI boundary edits

When editing a hook entry, adapter, daemon, installer, generated hook, or ledger
writer identified by `src/harness/e2e-boundary.ts`, add or run a fixture-backed
test: `npm run build:e2e && npm run test:e2e`. Fixtures own their cwd, sockets,
daemon PID and ledgers. Daemon assertions require a fresh transport receipt
with `outcome: "daemon"`, plus PID ownership; cold fallback is a separate case.

`interlinked e2e scaffold <name> --event PreToolUse --tool Edit` creates
`src/e2e/<name>.e2e.test.ts`. `--dry-run` prints it. Replace the deliberate
failure with the required behavior and add MUST-NOT-FIRE cases.
`npm run test:e2e:coverage` collects child coverage after `build:e2e`.
Its merger reads one raw child report at a time and retains only scripts under
the built `dist/` directory before a single bulk merge. Incremental V8 merges
are not equivalent because function/block granularity precedence changes.
The lane still requires every recorded
child to exit cleanly and flush coverage, includes product grandchildren, and
preserves zero-hit executable models. A passing test suite alone is insufficient:
the merge and strict coverage check must finish successfully. The merge stage
records total scripts read, retained bundle scripts, and unique merged scripts.
Vitest-only `src/test-setup/` helpers are outside the product boundary inventory;
their unit tests remain in the full test suite.
The source-only Jev entry modules `src/commands/jev.ts` and
`src/harness/jev/internal-cli.ts` are also outside that inventory. Any emitted runtime
bytes from either module fail inventory generation until it is reclassified. Runtime
shadow writers and isolated runtime bundles still retain zero-hit coverage obligations.
Route ratchet refusals to **interlinked-quality-gates**.

The advisory `[interlinked:e2e-obligation]` Stop warning credits only commands
observed in the current session. Run the lane from that session; another
agent's run, a terminal run, and unit-only evidence do not satisfy it. The viz
feed labels base, unit, integration, e2e and unknown lanes separately.
`E2E_STABILITY=1 npm run test:e2e` adds the 5,000-event stress case.
