"""文件：测试——MCP 服务器入口
测什么：模块暴露了 build_app 和 main 入口函数（防止重构时改丢）。
"""

from starit_mcp_server.main import build_app, main

__all__ = ["build_app", "main"]


def test_module_exposes_entrypoint() -> None:
    assert callable(main)
