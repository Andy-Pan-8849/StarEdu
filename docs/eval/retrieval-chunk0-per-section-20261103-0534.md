# Search evaluation report: chunk0-per-section

- Date: 2026-11-03T05:34:59+00:00  Commit: `c264feb`
- Knowledge base: 28 documents, 189 chunks (mean 59 tokens), chunk target 0 tokens
- Embedding model: `text-embedding-3-small`; rerank model: `openai/gpt-6-luna`
- Parameters: keyword top 30, vector top 30, RRF k=60, rerank input 20, final 6, context budget 3500 tokens

## Overall results (only answerable questions with a source document)

| mode | n | hit@1 | hit@3 | hit@6 | recall@6 | MRR | search p50 ms | p95 ms | overreaching chunks |
|---|---|---|---|---|---|---|---|---|---|
| keyword | 48 | 0.8333 | 1.0 | 1.0 | 1.0 | 0.9132 | 38.0 | 49.7 | 0 |
| vector | 48 | 1.0 | 1.0 | 1.0 | 0.9792 | 1.0 | 58.5 | 72.3 | 0 |
| hybrid | 48 | 1.0 | 1.0 | 1.0 | 0.9792 | 1.0 | 63.8 | 76.5 | 0 |
| hybrid_rerank | 48 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 2061.6 | 2908.2 | 0 |

## By question type (hit@6 / MRR, number of questions in brackets)

| Type | keyword | vector | hybrid | hybrid_rerank |
|---|---|---|---|---|
| access | 1.0 / 0.75 (4) | 1.0 / 1.0 (4) | 1.0 / 1.0 (4) | 1.0 / 1.0 (4) |
| keyword | 1.0 / 1.0 (3) | 1.0 / 1.0 (3) | 1.0 / 1.0 (3) | 1.0 / 1.0 (3) |
| multi | 1.0 / 1.0 (7) | 1.0 / 1.0 (7) | 1.0 / 1.0 (7) | 1.0 / 1.0 (7) |
| paraphrase | 1.0 / 1.0 (1) | 1.0 / 1.0 (1) | 1.0 / 1.0 (1) | 1.0 / 1.0 (1) |
| single | 1.0 / 0.914 (31) | 1.0 / 1.0 (31) | 1.0 / 1.0 (31) | 1.0 / 1.0 (31) |
| version | 1.0 / 0.75 (2) | 1.0 / 1.0 (2) | 1.0 / 1.0 (2) | 1.0 / 1.0 (2) |

## Questions whose source is not in the top 6

- **keyword**: none
- **vector**: none
- **hybrid**: none
- **hybrid_rerank**: none

## Top score: answerable vs unanswerable (median)

| mode | answerable | unanswerable / should refuse |
|---|---|---|
| keyword | 0.4444 | 0.3333 |
| vector | 0.6404 | 0.4869 |
| hybrid | 0.0328 | 0.0328 |
| hybrid_rerank | 10.0 | 3.0 |

(The distribution of these scores is the basis for the `grade_retrieval` threshold in M5.)

## Permission regression

54 questions × 7 roles × 3 modes, 1134 searches in all; **overreaching chunks: 0**.

## Cost

Question embedding 689 tokens; rerank input 112694 tokens, output 8554 tokens; estimated at public list prices at about US$0.01556 (prices come from a third-party price table, for reference only).

## Limits

- The knowledge base has only a few dozen chunks and the candidate lists cover almost everything, so the gaps between modes are compressed and **no conclusion about which is better at real scale can be drawn**.
- The evaluation set has only a few questions per type (keyword 3, version 2, paraphrase 1), and any single question moves the ratio visibly.
- The rerank result depends on the model and prompt used; on failure it falls back to the fusion order, and the number of failures is in each mode's run record.
