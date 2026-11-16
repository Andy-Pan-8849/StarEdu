# Search evaluation report: full

- Date: 2026-11-04T04:44:14+00:00  Commit: `71feb67`
- Knowledge base: 28 documents, 39 chunks (mean 286 tokens), chunk target 400 tokens
- Embedding model: `text-embedding-3-small`; rerank model: `openai/gpt-6-luna`
- Parameters: keyword top 30, vector top 30, RRF k=60, rerank input 20, final 6, context budget 3500 tokens

## Overall results (only answerable questions with a source document)

| mode | n | hit@1 | hit@3 | hit@6 | recall@6 | MRR | search p50 ms | p95 ms | overreaching chunks |
|---|---|---|---|---|---|---|---|---|---|
| keyword | 87 | 0.8621 | 0.9425 | 1.0 | 0.9828 | 0.9161 | 17.9 | 44.4 | 0 |
| vector | 87 | 0.8851 | 0.9885 | 1.0 | 0.9885 | 0.9397 | 20.5 | 30.5 | 0 |
| hybrid | 87 | 0.9425 | 1.0 | 1.0 | 0.9828 | 0.9713 | 35.9 | 147.5 | 0 |
| hybrid_rerank | 87 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1765.3 | 2736.8 | 0 |

## By question type (hit@6 / MRR, number of questions in brackets)

| Type | keyword | vector | hybrid | hybrid_rerank |
|---|---|---|---|---|
| access | 1.0 / 0.9091 (11) | 1.0 / 1.0 (11) | 1.0 / 0.9545 (11) | 1.0 / 1.0 (11) |
| keyword | 1.0 / 1.0 (13) | 1.0 / 0.8462 (13) | 1.0 / 1.0 (13) | 1.0 / 1.0 (13) |
| multi | 1.0 / 0.8929 (7) | 1.0 / 1.0 (7) | 1.0 / 0.9286 (7) | 1.0 / 1.0 (7) |
| paraphrase | 1.0 / 0.8364 (11) | 1.0 / 0.8636 (11) | 1.0 / 0.9091 (11) | 1.0 / 1.0 (11) |
| single | 1.0 / 0.95 (35) | 1.0 / 0.95 (35) | 1.0 / 0.9857 (35) | 1.0 / 1.0 (35) |
| version | 1.0 / 0.8 (10) | 1.0 / 1.0 (10) | 1.0 / 1.0 (10) | 1.0 / 1.0 (10) |

## Questions whose source is not in the top 6

- **keyword**: none
- **vector**: none
- **hybrid**: none
- **hybrid_rerank**: none

## Top score: answerable vs unanswerable (median)

| mode | answerable | unanswerable / should refuse |
|---|---|---|
| keyword | 0.6 | 0.4444 |
| vector | 0.5326 | 0.3891 |
| hybrid | 0.0328 | 0.0328 |
| hybrid_rerank | 10.0 | 1.0 |

(The distribution of these scores is the basis for the `grade_retrieval` threshold in M5.)

## Permission regression

114 questions × 7 roles × 3 modes, 2394 searches in all; **overreaching chunks: 0**.

## Cost

Question embedding 1461 tokens; rerank input 713760 tokens, output 15912 tokens; estimated at public list prices at about US$0.07936 (prices come from a third-party price table, for reference only).

## Limits

- The knowledge base has only a few dozen chunks and the candidate lists cover almost everything, so the gaps between modes are compressed and **no conclusion about which is better at real scale can be drawn**.
- The evaluation set has only a few questions per type (keyword 3, version 2, paraphrase 1), and any single question moves the ratio visibly.
- The rerank result depends on the model and prompt used; on failure it falls back to the fusion order, and the number of failures is in each mode's run record.
