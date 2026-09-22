from __future__ import annotations

import json

from pinch_classifier.experiment import _build_arg_parser, run_experiment

from .conftest import make_dataset_csv


def _make_corpus(tmp_path):
    sessions = []
    for i in range(3):
        sessions.append(make_dataset_csv(tmp_path, f"idle_{i}.csv", "idle", row_count=120, start_ns=i * 10_000_000_000))
        sessions.append(
            make_dataset_csv(
                tmp_path, f"pinch_start_{i}.csv", "pinch_start", row_count=120,
                start_ns=(i + 10) * 10_000_000_000, accel_bias=5.0,
            )
        )
        sessions.append(
            make_dataset_csv(
                tmp_path, f"pinch_release_{i}.csv", "pinch_release", row_count=120,
                start_ns=(i + 20) * 10_000_000_000, accel_bias=-5.0,
            )
        )
    return sessions


def _run(tmp_path, **overrides):
    args_list = [
        "--input", str(tmp_path),
        "--output", str(tmp_path / "report.json"),
        "--window-ms", "200",
        "--stride-ms", "100",
        "--test-size", "0.34",
        "--random-seed", "7",
    ]
    for key, value in overrides.items():
        args_list.extend([f"--{key.replace('_', '-')}", str(value)])
    parser = _build_arg_parser()
    args = parser.parse_args(args_list)
    return run_experiment(args)


def test_experiment_report_has_baseline_and_candidate_metrics(tmp_path):
    _make_corpus(tmp_path)
    report = _run(tmp_path)

    assert report["baseline"]["metrics"]["accuracy"] is not None
    assert report["candidate"]["metrics"]["accuracy"] is not None
    assert len(report["candidate"]["feature_names"]) > len(report["baseline"]["feature_names"])
    assert report["dataset_counts"]["n_sessions_total"] == 9
    assert report["dataset_counts"]["n_windows_kept"] > 0
    assert report["dataset_counts"]["n_windows_rejected_timestamp_quality"] == 0
    assert not set(report["split"]["groups_train"]) & set(report["split"]["groups_test"])
    assert isinstance(report["recommendation"], str) and report["recommendation"]


def test_experiment_is_deterministic(tmp_path):
    _make_corpus(tmp_path)
    report_a = _run(tmp_path)
    report_b = _run(tmp_path)

    assert report_a["baseline"]["metrics"]["accuracy"] == report_b["baseline"]["metrics"]["accuracy"]
    assert report_a["candidate"]["metrics"]["accuracy"] == report_b["candidate"]["metrics"]["accuracy"]
    assert report_a["split"]["groups_test"] == report_b["split"]["groups_test"]


def test_experiment_reports_rejected_windows_for_irregular_session(tmp_path):
    _make_corpus(tmp_path)
    make_dataset_csv(
        tmp_path, "idle_irregular.csv", "idle", row_count=60,
        start_ns=90_000_000_000, gap_after_row=10, gap_ns=100_000_000,
    )
    report = _run(tmp_path)

    assert report["dataset_counts"]["n_windows_rejected_timestamp_quality"] > 0
    assert report["dataset_counts"]["rejection_reasons"]


def test_experiment_cli_writes_json_report(tmp_path):
    _make_corpus(tmp_path)
    from pinch_classifier.experiment import main

    output_path = tmp_path / "report.json"
    exit_code = main([
        "--input", str(tmp_path), "--output", str(output_path),
        "--window-ms", "200", "--stride-ms", "100", "--test-size", "0.34", "--random-seed", "7",
    ])
    assert exit_code == 0
    report = json.loads(output_path.read_text(encoding="utf-8"))
    assert "recommendation" in report
