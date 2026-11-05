"""文件：ingest/__init__.py
作用：文档入库流水线（设计见 docs/design/05）。把一份原始文件变成可检索的文本块：
解析(parsers) -> 清洗(clean) -> 切块(chunker) -> 提取编号(identifiers) -> 嵌入(embeddings) ->
  写库(pipeline)。
任务排队与领取在 queue.py，后台循环在 worker.py，按清单登记文档在 register.py。
"""
