"""文件：测试——worker 命令行入口
测什么：默认一直运行；--once 表示处理完现有任务就退出。
"""

from starit_worker.main import parse_args


def test_defaults_to_running_forever() -> None:
    assert parse_args([]).once is False


def test_once_flag() -> None:
    assert parse_args(["--once"]).once is True
