"""What the user is told when the assistant cannot answer.

Not found and no permission use the same words on purpose: a different message would tell a
user that a restricted document exists.
"""

NOT_FOUND = (
    "Based on the documents available to your account, I could not find information to "
    "answer that. Please check the wording, or ask the relevant team."
)

CLARIFICATION_LIMIT = (
    "I still could not work out what you are asking. Please rephrase the question with more "
    "detail, or contact support."
)

CLARIFICATION_FALLBACK = "Could you tell me a little more about what you need?"

CHITCHAT = (
    "Hello! I can answer questions about StarIT Education's policies and procedures: HR, "
    "finance, and technical support. What would you like to know?"
)

REFUSED = {
    "out_of_scope": (
        "I can only help with questions about StarIT Education's policies and procedures: "
        "HR, finance and technical support."
    ),
    "input_blocked": "I cannot process that message. Please ask your question in plain words.",
    "write_not_enabled": (
        "I cannot make changes or submit anything for you yet. I can explain the policy or "
        "the steps to do it yourself."
    ),
    "not_available_yet": (
        "Looking up business data (such as employee, student or claim records) is not "
        "available yet. I can answer questions about policies and procedures."
    ),
}

ERROR = (
    "Something went wrong while answering. Please try again; if it keeps happening, "
    "mention this reference: {run_id}."
)
