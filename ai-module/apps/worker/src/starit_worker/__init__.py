"""文件：starit_worker/__init__.py
作用：入库 worker 服务：后台不断从任务队列领取文档，解析、切块、嵌入、写库。
真正的逻辑在 starit_core.ingest；这里只是进程入口（main.py）。
"""
