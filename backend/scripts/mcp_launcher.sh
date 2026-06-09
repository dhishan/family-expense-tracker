#!/bin/bash
# Launcher for the SnapTrade MCP server. Used by Claude Desktop / Code config.
cd "$(dirname "$0")/.."
exec .venv/bin/python -m scripts.snaptrade_mcp
