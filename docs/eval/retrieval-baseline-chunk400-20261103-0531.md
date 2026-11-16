# Search evaluation report: baseline-chunk400

- Date: 2026-11-03T05:31:27+00:00  Commit: `c264feb`
- Knowledge base: 28 documents, 39 chunks (mean 286 tokens), chunk target 400 tokens
- Embedding model: `text-embedding-3-small`; rerank model: `openai/gpt-6-luna`
- Parameters: keyword top 30, vector top 30, RRF k=60, rerank input 20, final 6, context budget 3500 tokens

## Overall results (only answerable questions with a source document)

| mode | n | hit@1 | hit@3 | hit@6 | recall@6 | MRR | search p50 ms | p95 ms | overreaching chunks |
|---|---|---|---|---|---|---|---|---|---|
| keyword | 48 | 0.8958 | 0.9583 | 1.0 | 0.9792 | 0.9365 | 13.9 | 20.0 | 0 |
| vector | 48 | 0.9167 | 0.9792 | 1.0 | 0.9792 | 0.9531 | 19.8 | 26.7 | 0 |
| hybrid | 48 | 0.9375 | 1.0 | 1.0 | 0.9792 | 0.9688 | 21.9 | 31.8 | 0 |
| hybrid_rerank | 48 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 2121.0 | 2820.1 | 0 |

## By question type (hit@6 / MRR, number of questions in brackets)

| Type | keyword | vector | hybrid | hybrid_rerank |
|---|---|---|---|---|
| access | 1.0 / 1.0 (4) | 1.0 / 1.0 (4) | 1.0 / 1.0 (4) | 1.0 / 1.0 (4) |
| keyword | 1.0 / 1.0 (3) | 1.0 / 0.8333 (3) | 1.0 / 0.8333 (3) | 1.0 / 1.0 (3) |
| multi | 1.0 / 0.8929 (7) | 1.0 / 1.0 (7) | 1.0 / 0.9286 (7) | 1.0 / 1.0 (7) |
| paraphrase | 1.0 / 0.5 (1) | 1.0 / 1.0 (1) | 1.0 / 1.0 (1) | 1.0 / 1.0 (1) |
| single | 1.0 / 0.9419 (31) | 1.0 / 0.9435 (31) | 1.0 / 0.9839 (31) | 1.0 / 1.0 (31) |
| version | 1.0 / 1.0 (2) | 1.0 / 1.0 (2) | 1.0 / 1.0 (2) | 1.0 / 1.0 (2) |

## Questions whose source is not in the top 6

- **keyword**: none
- **vector**: none
- **hybrid**: none
- **hybrid_rerank**: none

## Top score: answerable vs unanswerable (median)

| mode | answerable | unanswerable / should refuse |
|---|---|---|
| keyword | 0.6 | 0.4737 |
| vector | 0.5406 | 0.4641 |
| hybrid | 0.0328 | 0.0328 |
| hybrid_rerank | 10.0 | 2.0 |

(The distribution of these scores is the basis for the `grade_retrieval` threshold in M5.)

## Permission regression

54 questions × 7 roles × 3 modes, 1134 searches in all; **overreaching chunks: 0**.

## Cost

Question embedding 689 tokens; rerank input 318665 tokens, output 7546 tokens; estimated at public list prices at about US$0.03565 (prices come from a third-party price table, for reference only).

## Limits

- The knowledge base has only a few dozen chunks and the candidate lists cover almost everything, so the gaps between modes are compressed and **no conclusion about which is better at real scale can be drawn**.
- The evaluation set has only a few questions per type (keyword 3, version 2, paraphrase 1), and any single question moves the ratio visibly.
- The rerank result depends on the model and prompt used; on failure it falls back to the fusion order, and the number of failures is in each mode's run record.
