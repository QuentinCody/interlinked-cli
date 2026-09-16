/** Same-process pytest observer; no dependency beyond the selected pytest installation. */
export const PYTEST_CASE_PLUGIN = String.raw`
import json
import pathlib
import sys
import pytest

class CaseObserver:
    def __init__(self, destination, identity, runtime):
        self.destination = pathlib.Path(destination)
        self.identity = identity
        self.cases = {}
        self.collection_errors = 0
        self.collection_skips = 0
        self.runtime = runtime
        self.distributed = False

    def pytest_configure(self, config):
        self.distributed = bool(getattr(config.option, "numprocesses", None) or
                                getattr(config.option, "tx", None) or
                                getattr(config.option, "dist", "no") != "no")

    def pytest_collection_finish(self, session):
        self.cases = {item.nodeid: {} for item in session.items}

    def pytest_collectreport(self, report):
        if report.failed:
            self.collection_errors += 1
        if report.skipped:
            self.collection_skips += 1

    def pytest_runtest_logreport(self, report):
        phases = self.cases.setdefault(report.nodeid, {})
        phases[report.when] = report.outcome

    def pytest_sessionfinish(self, session, exitstatus):
        report = {"identity": self.identity, "finished": True,
                  "exit": int(exitstatus), "collectionErrors": self.collection_errors,
                  "collectionSkips": self.collection_skips,
                  "distributed": self.distributed,
                  "runtime": runtime_evidence(self.runtime),
                  "cases": [{"id": key, "phases": value}
                            for key, value in self.cases.items()]}
        self.destination.parent.mkdir(parents=True, exist_ok=True)
        self.destination.write_text(json.dumps(report), encoding="utf-8")

def module_paths(module):
    attributes = vars(module)
    filename = attributes.get("__file__")
    if isinstance(filename, str):
        yield pathlib.Path(filename).resolve()
    for location in attributes.get("__path__", []):
        if isinstance(location, str):
            yield pathlib.Path(location).resolve()

def original_imports(original, staged):
    environment = pathlib.Path(sys.prefix).resolve()
    virtual_environment = environment != original and (environment / "pyvenv.cfg").is_file()
    violations = set()
    for module in list(sys.modules.values()):
        if module is None:
            continue
        for location in module_paths(module):
            if not location.is_relative_to(original) or location.is_relative_to(staged):
                continue
            if virtual_environment and location.is_relative_to(environment):
                continue
            violations.add(str(location.relative_to(original)))
    return sorted(violations)

def runtime_evidence(runtime):
    if runtime is None:
        return {"status": "not_requested"}
    original = pathlib.Path(runtime["original"]).resolve()
    staged = pathlib.Path.cwd().resolve()
    report = {"original": str(original), "staged": str(staged)}
    try:
        violations = original_imports(original, staged)
        report.update(status="invalid" if violations else "checked", violations=violations)
    except Exception as error:
        report.update(status="unknown", reason=str(error))
    return report

observer = CaseObserver(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))
raise SystemExit(pytest.main(sys.argv[4:], plugins=[observer]))
`;
