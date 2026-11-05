"""文件：starit_api/__init__.py
作用：AI 模块的 HTTP API 服务（FastAPI）。
文件分工：main.py 应用与启动 / deps.py 依赖注入与鉴权 / errors.py 统一错误格式 /
limits.py 限流与预算 / conversations.py 会话与聊天(含 SSE 流式) / documents.py 文档管理。
契约见 docs/design/03-api-and-mcp-contract.md。
"""
