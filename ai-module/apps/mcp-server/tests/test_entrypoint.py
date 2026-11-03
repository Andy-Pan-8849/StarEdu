from starit_mcp_server.main import build_app, main

__all__ = ["build_app", "main"]


def test_module_exposes_entrypoint() -> None:
    assert callable(main)
