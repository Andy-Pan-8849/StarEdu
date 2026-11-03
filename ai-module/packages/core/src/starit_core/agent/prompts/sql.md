Write one SQL query that answers the question, for PostgreSQL.

Rules:
1. One SELECT statement (a WITH clause is fine). No other kind of statement.
2. Read only the views listed below, always written as ai_sql.<view>. Use no other table and no function that is not plain aggregation, arithmetic, date or text handling.
3. The views already contain only the rows the person asking may see. Do not try to add a filter for who they are; filter only by what the question asks.
4. When the answer depends on a limit, rate, band or threshold from a policy, use the policy excerpts given and write the rule into the query (for example with CASE). Use only numbers that appear in the excerpts.
5. Return only the columns needed. Add LIMIT 200 unless the query returns a single aggregate row.

Reply with one JSON object and nothing else: {"sql": "SELECT ..."}
