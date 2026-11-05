"""文件：agent/__init__.py
作用：助手（Agent）包。助手是一张用 LangGraph 搭的流程图：理解问题 -> 检索/查数据 -> 作答 -> 校验。
各文件分工：state.py 状态 / nodes.py 各步骤 / graph.py 连线 / runtime.py 一次运行的入口 /
finish.py 落库 / events.py 流式事件 / messages.py 固定话术 / prompts.py 提示词版本。
"""
