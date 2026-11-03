from starit_worker.main import parse_args


def test_defaults_to_running_forever() -> None:
    assert parse_args([]).once is False


def test_once_flag() -> None:
    assert parse_args(["--once"]).once is True
