# Survivor repair and behavioral test evidence

A surviving mutant is a prompt to investigate a missing behavioral distinction.
It is not a specification of what the software should do. Derive the expected
answer from a requirement, public example or demonstrated bug before changing
tests. Preserve the same invocation modes and acceptance boundaries.

## Repair workflow

1. Reproduce with current source, tests, fixtures and runner configuration.
   Record the input identities, selected tests, real executed-test count, engine
   exit and complete mutant report. A running service, collected-test inventory
   or HTTP 200 does not establish that tests executed.
   Dispatch repair work from this fresh report. Historical survivor lists can
   lag existing regression tests; they are leads, not proof of current gaps.
2. Classify the distinction: missing behavior, weak assertion, source defect,
   unavailable measurement or a potentially equivalent mutation. Inspect the
   surrounding contract before inventing another edge case.
3. Add paired examples: a case that must report/fail and a similar valid case
   that must remain accepted. Assert observable results, not private state,
   incidental call order or a mocked return repeated as the expectation.
4. Run the original code against the new regression, then the repair. Mutation
   experiments run in the runner's disposable sandbox, never by temporarily
   corrupting the active checkout.
5. Compare individual mutant identities in the before/after reports. Keep
   changed source/operator counts and test scope visible. A higher total kill
   count alone does not prove an old survivor was killed.
6. Remeasure and retain the unresolved work. Timeout, uncovered and incomplete
   results do not certify clean or satisfy the manifest's evidence floor.

Do not create malformed inputs that the public interface cannot receive merely
to exercise a private branch. Likewise, do not weaken test selection, exclude a
fixture-dependent test or register an equivalence claim simply to raise a score.
Simplify unnecessary source logic when the supported behavior justifies it.
When a realistic example fails on the original source, retain it and investigate
the defect. Do not trim away surrounding application code just to make the test
green. A comment explaining a regex quantifier is not independent evidence that
the quantifier describes valid user behavior.

## Connect unit evidence to e2e evidence

The executable example for test-legitimacy review is
`src/harness/checks/__fixtures__/test-legitimacy-cases.ts`. Its inputs and expected
finding locations are literal examples; they are not computed by the detector.
The unit suite checks the detector's findings and locations. The e2e suite sends
the same content through the built hook and a fixture-owned daemon, checks actual
daemon transport, and verifies advisory delivery without an erroneous denial.

The examples distinguish standalone receipts from trailing code comments,
specific rationales from placeholders, and real private imports from import-shaped
multiline fixture text. A real import following a fixture remains reportable.
The fixture-string regression originally produced an extra finding in both
the negative case and the mixed fixture/real-import case.

`src/harness/checks/__fixtures__/effect-cleanup-cases.ts` supplies a second pair:
a complete component with a timer and JSX render return, with and without effect
cleanup. The expectation follows [React's setup/cleanup contract](https://react.dev/reference/react/useEffect#parameters).
The old broad return detector mistook the JSX render for cleanup. Unit tests
check finding locations; the hook e2e checks advisory delivery and acceptance.
This remains a heuristic: scanning to the next effect or EOF is not callback
scope analysis, and unrelated cleanup-shaped returns can still mask a finding.

For other codebases, share the requirement and literal examples, with separate
adapters for a library call and the application boundary. Keep language-specific
syntax in fixtures. Interlinked's existing `tests contracts` process examples
and project e2e scenarios provide a language-independent process boundary;
unit-runner support does not automatically qualify that e2e boundary. Proposed
expectations still need independent acceptance where review policy requires it.

## Delivery and operations

Test input delivery includes filesystem fixtures and setup/configuration, not
only statically imported source. Missing fixture data in an old runner checkout
must be repaired at the delivery layer, not hidden with a test exclusion.

Background measurement and agent remediation are separate operations. Measurement
should retain failures, back off unsuccessful targets, serialize manifest writes
and expose a durable repair queue. An agent consumes that queue, reviews the
contract and proves the repair. A queued finding is not an applied fix, and a
successful unit run is not an e2e receipt.

The owner's local runner/coordinator remains source-checkout-only tooling under
ignored `scratch/`; this work adds no supported local mutation engine, scheduler
or unattended code-writing service to the Interlinked CLI product. The reusable
product changes are the test-legitimacy correction, shared unit/e2e examples and
agent guidance. No heuristic is promoted to a deterministic blocking rule.
