"""文件：starit_eval/__init__.py
作用：评测工具包——衡量助手“找得准不准、答得对不对、会不会越权、数据查得对不对”。
文件分工：cli.py 命令行入口 / dataset.py 题库与演示账号 / runner.py 跑检索 / metrics.py
  检索指标 /
leak.py 独立的越权检查 / answers.py 答案评测 / data_check.py 数据题评测 / agent_check.py
  代表性问题检查 /
matrix.py 检索与切块的对比实验 / report.py 汇总报告 / pricing.py 费用估算 / suite.py 总流程。
重要原则：任何会花钱的评测，先打印调用次数和预估费用，经确认才运行。
"""
