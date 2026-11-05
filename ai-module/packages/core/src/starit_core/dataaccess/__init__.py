"""文件：dataaccess/__init__.py
作用：助手访问业务数据（学员、报销、工单等）的包。
两条路：① 固定工具(tools.py，经 MCP 服务调用，client.py 是客户端)，参数明确、最安全；
② 模型自己写 SQL(sqlguard.py 校验后在只读视图上执行)，灵活但要多层防护。
schema.py 描述有哪些视图、谁能用。
"""
