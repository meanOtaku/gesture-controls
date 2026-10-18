# Disposable label-lag audit

Run from this directory:

```sh
PYTHONDONTWRITEBYTECODE=1 /home/vaibhav/.local/share/uv/tools/headroom-ai/bin/python /tmp/ppg-label-lag-audit/audit.py
```

Requires the existing NumPy environment and read-only source files listed in source-hashes.json. No models are imported or trained. Only selected frozen parser/event/evaluator AST definitions are executed; model code is excluded. No prediction values are modified. All outputs and temporary paths are restricted to this directory. Re-running replaces only these audit outputs.

Read report.md for interpretation and audit.json for full sweeps. Shift sign: positive moves labels later. Primary sweep reapplies label eligibility after shifting; fixed zero-cohort results diagnose boundary effects. Pooling follows the CV study: repeated held-out appearances count repeatedly. Zero-shift reproduction and source immutability are asserted on every run. No repository, data, git, or previous study artifacts are written.

This is a descriptive audit, not model validation or improvement. No confidence interval is claimed. An optimum shift is only evidence compatible with label delay and may reflect model bias or repeated gestures; it does not reveal physical ground truth.
