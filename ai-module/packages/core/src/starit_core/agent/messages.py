"""文件：agent/messages.py
作用：助手无法回答时对用户说的固定话术。
主要思想：“没找到”和“没权限”故意用同一句话——不同的话会让用户知道受限文档存在。
这些文本是产品行为的一部分，评测和测试会按它们断言，修改前要同步改测试。
"""

# 文档类问题找不到（或无权限）时的回复
NOT_FOUND = (
    "Based on the documents available to your account, I could not find information to "
    "answer that. Please check the wording, or ask the relevant team."
)

# 数据类问题查不到记录（或无权限）时的回复
NO_MATCHING_ROWS = (
    "I could not find any records matching that among the data available to your account. "
    "Please check the wording, or ask the relevant team."
)

# 已经反问过一次仍然不明白时的回复（只反问一次，不无限追问）
CLARIFICATION_LIMIT = (
    "I still could not work out what you are asking. Please rephrase the question with more "
    "detail, or contact support."
)

# 模型没给出反问内容时的兜底反问
CLARIFICATION_FALLBACK = "Could you tell me a little more about what you need?"

# 打招呼、闲聊的回复：介绍能做什么
CHITCHAT = (
    "Hello! I can answer questions about StarIT Education's policies and procedures: HR, "
    "finance, and technical support. What would you like to know?"
)

# 拒绝的三种原因：超出范围 / 输入被拦截 / 写操作暂不支持
REFUSED = {
    "out_of_scope": (
        "I can only help with questions about StarIT Education's policies and procedures "
        "(HR, finance and technical support) and with looking up your business data."
    ),
    "input_blocked": "I cannot process that message. Please ask your question in plain words.",
    "write_not_enabled": (
        "I cannot make changes or submit anything for you yet. I can explain the policy or "
        "the steps to do it yourself."
    ),
}

# 运行出错时的回复，带运行 ID 方便排查
ERROR = (
    "Something went wrong while answering. Please try again; if it keeps happening, "
    "mention this reference: {run_id}."
)
