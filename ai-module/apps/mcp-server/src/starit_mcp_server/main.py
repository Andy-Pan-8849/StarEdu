"""Entry point (MCP server (stub until M6))."""

import logging

from starit_core.config import get_settings
from starit_core.logging import configure_logging


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    logging.getLogger("starit_mcp_server").info("starit-mcp-server started (stub)")


if __name__ == "__main__":
    main()
