# Edit feedback policy, October 6, 2026

The operator requested reducing interruption and unnecessary abstractions observed
during the decision-metrics implementation. These changes distinguish a measured
pattern from proof of a defect and preserve explicit enforcement as an option.

- Repeated warnings remain advisory. The legacy `persistent_warning_escalation`
  identifier is retained for readers, but it cannot increase severity or confidence.
- Guard-scope prediction defaults to `harness.guard_prediction.mode: "shadow"`.
  Exact changes remain in the local ledger. The default requires no receipt;
  explicit `"enforced"` retains the predict/reveal/reconcile protocol.
- Function token, cyclomatic and cognitive thresholds advise during edits by
  default. `harness.edit_metrics.mode: "enforced"` retains the previous refusal.
  `"advisory"` states the default explicitly. Invalid explicit values retain
  enforcement with a diagnostic. Metric values and protected baselines are unchanged.
- Ordinary hook feedback follows the same deep-audit ID set as default verify.
  Full check records remain available, with one review notice per session. Blocking
  decisions and error findings are not filtered. Explicit `verify --all-checks`
  still exposes the review catalogue. Guard advice is deduplicated per session.
  The same policy covers late-warning spool delivery, with separate novelty state
  so preparing a fallback cannot consume the synchronous response's notice.
- An interactive compiler batch must not accidentally invoke a repository-wide
  Gitleaks scan because its engine scope is named `project`. That scan is deferred
  explicitly to background recovery or `verify`. Existing inline secret checks
  remain active, and a deferral cannot count as a successful security scan.

The sampled parent-session log contained 30-second Gitleaks timeouts in hook
cycles totaling about 52–55 seconds. This is a concrete scheduling defect, not a
reason to disable secret detection or claim success after a timeout. Tests cover
foreground non-execution, recovery admission, explicit policy modes, security
blocking, retained evidence and warning delivery. Post-deployment measurements
must distinguish raw findings, native delivery and completed-tool timings.

After the first rebuild, observed parent-session checked edits took 9.664 and
26.372 seconds without a 30-second Gitleaks invocation. A later 61.079-second
cycle had no external-tool execution and substantial event-loop yield time;
removing the secret-scan timeout does not resolve all latency under concurrent
work. These are opportunistic observations, not a paired performance experiment.

Live daemon dry-run probes allowed a guard-scope change without a receipt and a
synthetic function exceeding the complexity caps with advice. A destructive root
deletion probe remained blocked. No hypothetical source edit or deletion ran.
Single-file Gitleaks no-ops now report deferred rather than a successful scan.
The late-delivery regression test verifies that style advice is filtered while
security feedback and the returned raw evidence survive.
