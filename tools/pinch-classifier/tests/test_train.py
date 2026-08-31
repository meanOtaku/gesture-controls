from __future__ import annotations

import json

from pinch_classifier.train import main

from .conftest import make_dataset_csv


def _make_corpus(tmp_path):
    """Several sessions per label so grouped holdout has something on both sides."""
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


def test_train_cli_end_to_end(tmp_path):
    _make_corpus(tmp_path)
    output_dir = tmp_path / "artifacts"

    exit_code = main(
        [
            "--input", str(tmp_path),
            "--output-dir", str(output_dir),
            "--window-ms", "200",
            "--stride-ms", "100",
            "--test-size", "0.34",
            "--random-seed", "7",
        ]
    )

    assert exit_code == 0
    assert (output_dir / "model.joblib").exists()

    model_card = json.loads((output_dir / "model_card.json").read_text(encoding="utf-8"))
    assert model_card["hold_handling"] == "exclude"
    assert set(model_card["classes"]) <= {"idle", "pinch_start", "pinch_release", "negative"}
    assert "false_activation_rate" in model_card["metrics"]
    assert "confusion_matrix" in model_card["metrics"]
    # No session should appear in both the train and test group lists.
    assert not set(model_card["groups_train"]) & set(model_card["groups_test"])


def test_train_cli_is_deterministic(tmp_path):
    _make_corpus(tmp_path)
    output_a = tmp_path / "artifacts_a"
    output_b = tmp_path / "artifacts_b"

    common_args = [
        "--input", str(tmp_path),
        "--window-ms", "200",
        "--stride-ms", "100",
        "--test-size", "0.34",
        "--random-seed", "7",
    ]
    main([*common_args, "--output-dir", str(output_a)])
    main([*common_args, "--output-dir", str(output_b)])

    card_a = json.loads((output_a / "model_card.json").read_text(encoding="utf-8"))
    card_b = json.loads((output_b / "model_card.json").read_text(encoding="utf-8"))

    assert card_a["metrics"]["accuracy"] == card_b["metrics"]["accuracy"]
    assert card_a["metrics"]["confusion_matrix"] == card_b["metrics"]["confusion_matrix"]
    assert card_a["groups_test"] == card_b["groups_test"]


def test_train_cli_rejects_single_session(tmp_path):
    make_dataset_csv(tmp_path, "only_one.csv", "idle", row_count=50)
    try:
        main(["--input", str(tmp_path), "--output-dir", str(tmp_path / "artifacts")])
        assert False, "expected SystemExit"
    except SystemExit as exc:
        assert "at least 2 distinct recording sessions" in str(exc)
