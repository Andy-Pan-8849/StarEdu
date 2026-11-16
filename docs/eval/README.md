# Evaluation records

[中文](README.chn.md)

Each run produces a pair of files (a `.md` report and `.json` data), and also one row per mode in the database's `ai.eval_runs` / `ai.eval_results`. How to run it is in [`ai-module/README.md`](../../ai-module/README.md).

The Markdown reports in this directory are archived output of the evaluation tool. The tool writes them in Chinese; the files with the `.chn.md` suffix are the original Chinese reports and the files without it are English translations of the same content (the data-check reports were already in English).

## M4 baseline (2026-11-03, commit `c264feb`)

Two real runs, the same 54 evaluation questions (48 answerable questions with a source document) and the same knowledge base (28 documents), changing only the chunking:

| Chunking | Mode | hit@1 | hit@3 | hit@6 | MRR | Search p50 |
|---|---|---|---|---|---|---|
| Target 400 tokens (39 chunks, median 358) | keyword | 0.896 | 0.958 | 1.0 | 0.937 | 14 ms |
| | vector | 0.917 | 0.979 | 1.0 | 0.953 | 20 ms |
| | hybrid | 0.938 | 1.0 | 1.0 | 0.969 | 22 ms |
| | hybrid_rerank | 1.0 | 1.0 | 1.0 | 1.0 | 2,121 ms |
| One chunk per section (189 chunks, median 50) | keyword | 0.833 | 1.0 | 1.0 | 0.913 | 38 ms |
| | vector | 1.0 | 1.0 | 1.0 | 1.0 | 59 ms |
| | hybrid | 1.0 | 1.0 | 1.0 | 1.0 | 64 ms |
| | hybrid_rerank | 1.0 | 1.0 | 1.0 | 1.0 | 2,062 ms |

Reports: [chunk target 400](retrieval-baseline-chunk400-20261103-0531.md), [one chunk per section](retrieval-chunk0-per-section-20261103-0534.md).

### What can and cannot be read from it

- **hit@6 is 1.0 everywhere**: the knowledge base has only a few dozen chunks, so the top 6 almost always contain the source, and this metric is saturated. The difference shows only in how far to the front the rank is (hit@1, MRR).
- **Rerank (hybrid_rerank) scored full marks both times**, at the price of latency (about 2 seconds against tens of milliseconds) and cost (about US$0.036 / US$0.016 for 54 questions). Not one of the 108 rerank calls had to fall back to the fusion order.
- **Exact codes**: `ERR-PORTAL-429` (DOC-30) in the 400-token chunking: vector search puts the chunk holding `ERR-PORTAL-403` first (the two error codes are very close in vector space), and the RRF of hybrid search also leaves it in front; only rerank and keyword search put the correct source first. This confirms why keyword search and the `identifiers` field are kept.
- **Finer chunks help vector and hybrid** (hit@1 rises from 0.92 / 0.94 to 1.0) and are slightly worse for keyword. But this measures only "which document is found" and **does not measure whether the context needed to generate an answer is enough**: with one chunk per section, 6 chunks are only about 350 tokens. Whether to change the default chunking has to wait until after M5 and be judged together with answer quality.
- **Top scores of unanswerable questions**: the rerank score (0 to 10) is 10 on all answerable questions (48) and 0, 0, 1, 2, 5, 8 on the 6 unanswerable or to-be-refused ones. The keyword and vector scores separate very little (0.60 against 0.47, 0.54 against 0.46). This is the basis in M5 for judging "is the evidence enough": using the rerank score is more reliable than the other two, but the sample is very small, and the one with 8 (an employee asking about the bonus file only HR can see, where a relevant passage that cannot answer the question was found) shows that the gap of the threshold is not wide.
- **Permissions**: each run did 54 questions × 7 roles × 3 modes = 1,134 searches, checking every returned chunk with independent rules, **with 0 overreach**.

### Limits

The knowledge base is too small and the evaluation questions too few, with only a few per question type (keyword 3, version 2, paraphrase 1). These numbers are used to confirm that the flow is correct and to see the direction, and cannot show how the methods compare at real scale. M8 expands the evaluation questions and the documents.


## M5 real check of the assistant (2026-11-03)

`make eval ARGS="agent --compare-generate openai/gpt-4o-mini"`: 15 rounds (14 groups of scenarios) really asked to the assistant, comparing whether the generation step uses `gpt-6-luna` (the default) or `gpt-4o-mini` (understanding and rerank use `gpt-6-luna` in both versions). The verdict looks only at the end state and whether the answer contains the key fact. Two runs:

| Run | Default (luna) | gpt-4o-mini | Note |
|---|---|---|---|
| [First](agent-check-20261103-0612.md) | 14/15 | 11/15 | Exposed two problems (see below) |
| [After the fixes](agent-check-20261103-0620.md) | 14/15 | 12/15 | The two problems were fixed |

### The two problems the check found and fixed

1. **The rerank prompt cut passages at 350 tokens.** The answer to `ERR-PORTAL-429` is at the 365th token of the chunk it is in, so the rerank model could not see it and gave only 2 (out of 10), and the first gate (a score of at least 6) therefore refused to answer, and both models answered "not found". The M4 baseline did not find it, because it only looked at ranking (it still ranked first) and not at absolute scores. The truncation limit was changed to 600 (above the chunk limit of 500), and the same chunk then steadily scores 10; a regression test was added (which also asserts that the old limit of 350 really would hide that line).
2. **The understand step treated the slow-Maven question as out of scope.** The prompt did not make the scope of tech support explicit, and `gpt-6-luna` classified the same question differently in the two runs. The prompt now lists the development environment, the learning portal, courseware download, assignment submission, devices, VPN, the helpdesk and so on, and states clearly that "a tool that a student or employee uses not working is not out of scope" (prompt version 1 → 2).

### Differences that remain after the fixes (recorded honestly)

- **DOC-43 (old policy) "did not pass" in both versions, but this is a judging condition that was too strict, not a wrong answer by the assistant.** The question asks "what was the bonus under the old policy and which version applies now", and both models answered CNY 2,000 and that v2.1 applies; I had also required the answer to contain the new version's 3,000, which the question does not ask for. In the first run luna happened to say one sentence more and so passed. The condition was changed to "2,000, 2.1, superseded", later checks follow the new condition, and the two reports already committed were kept as they were, as a record.
- **gpt-4o-mini consistently got the late-penalty question (DOC-40) wrong**, saying "over 72 hours, 0 points" (in fact 50 hours falls in the 48 to 72 hour band, takes 30% off, and gives 63), and the answer had no `[n]` citation mark and was stopped by verification, so what the user sees is an error notice and not a wrong answer. This shows that verification really can stop answers without citations, but **a wrong answer carrying citations passes**: in phase 1 verification does only deterministic checks, and having the model check the facts again is left to be decided after evaluation (confirmed in design 04).
- **gpt-4o-mini gave an answer on DOC-47 (the bonus formula only Finance and HR can see), citing `FIN-PAY-004` and `HR-PERF-006`.** Both are documents every employee can read, and the confidential `FIN-PAY-005` was not cited, so **this is not a leak**: the permission layer guarantees that the model never got the restricted content at all; it took "performance pay" for "the annual bonus formula", which is a small model answering too eagerly. The verdict now explicitly checks whether the answer cites a restricted document. The default luna answers "not found" to this question.
- Generation speed: a question that needs search takes about 4 to 10 seconds end to end (rerank about 2 seconds, the rest understanding and generation); one that needs no search (a greeting, out of scope, a write action, a data query) about 1 second.

### Conclusion

The default stays `gpt-6-luna`. On this batch of hard questions it is clearly better than `gpt-4o-mini` (14/15 against 12/15 after the fixes) and also cheaper. The sample is very small and each scenario was asked only once, so this only shows whether there is a clear difference on these hard questions.

## M8 full evaluation and experiment matrix (2026-11-04, after commit `71feb67`)

Two real runs: `starit-eval all` (114 document questions + 41 data questions, model `gpt-6-luna`, an estimated cost of about $0.25, in fact about 15 minutes) and `starit-eval matrix` (8 experiments, an estimated cost of about $0.02). Reports: [full](full-20261104-0457.md), [search](retrieval-full-20261104-0444.md), [answers](answers-20261104-0454.md) (with the 20% spot-check sheet `answers-20261104-0454.csv`, **the human spot check had not been done**), [data questions](data-check-20261104-0457.md), [matrix](matrix-20261104-0504.md).

### Full evaluation

- **Permission regression: passed.** 114 questions × 7 roles × 3 modes = 2,394 searches with 0 overreaching chunks; the per-question checks of the four modes are also all 0.
- **Search** (87 answerable questions with a source document): hit@1 keyword 0.862, vector 0.885, hybrid 0.943, hybrid_rerank 1.0; MRR 0.916 / 0.940 / 0.971 / 1.0; hit@6 is 1.0 everywhere (the knowledge base has only 39 chunks, and this metric was saturated long ago). The price of rerank is a search p50 of about 1.8 seconds (against tens of milliseconds).
- **Answers**: passed 99/114 (should-answer 74/87, should-refuse 25/27); scoring: facts 39 questions, judge 48 questions, refusal 27 questions; all end states valid (114/114); latency p50 5.5 seconds, p95 7.8 seconds. By type: keyword 13/13, unanswerable 11/12, paraphrase 10/11, access 24/26, version 8/10, single 28/35, multi 5/7.
- **Data questions**: 41/41 (should-answer 32/32, should-refuse 9/9), including the two that had once failed in M6.

### The 15 questions not passed, after reading each one

None was a permission leak. They fall into four classes (**this is my classification after reading the answers, not a conclusion of the script**):

1. **Correct answer but a minor detail missing, marked wrong by the judge (8 questions: DOC-05, 07, 25, 27, 28, 37, 43, 49).** For example DOC-05 answered "April and October" and missed "apply 4 weeks ahead"; DOC-28 answered Monday 09:00 and 3 devices and missed the monthly 5 GB download quota. Some omissions are justified (DOC-07 missed "a qualified substitute must be nominated", DOC-37 missed "the manager must approve beforehand", DOC-49 missed "the commission is clawed back in full on withdrawal"), and some are very minor. The judge judged by the standard "a key fact missing", and that standard is mine; whether to loosen or tighten it is decided after the 20% human spot check.
2. **Asked for clarification when it should have answered directly (4 questions: DOC-04 certification subsidy, DOC-31 assignment deadline, DOC-42 "which year", DOC-69 lost receipt).** This is a real behaviour problem of the `understand` step: the questions themselves can be answered from the documents. DOC-42 asking "which year" is especially needless. **Not fixed**, only recorded; the adjustment of the understand prompt (version 2) is left for later (see "Leftovers").
3. **A mistake of my scoring script (1 question: DOC-79).** The assistant answered "HR-REC-001 v2.1 is in force", and my fact matching does not recognise the `2.1` after a leading `v`. Fixed (the `v` prefix is tolerated, with a test added); **the numbers in the report are from the run before the fix and were not changed**, and under the fixed rule DOC-79 would pass (100/114).
4. **Answered when it should have refused (2 questions: DOC-90, DOC-108).**
   - **DOC-108** (an employee asks about an admissions advisor's commission, whose answer is in FIN-PAY-005, readable only by finance and HR): **no leak**: the assistant cited only the three documents the employee could read anyway, the answer contains no restricted fact such as 3%, and says "the provided excerpts do not state the commission". But its end state was `answered` and not `not_found`: the generate step judged "the material is enough" and yet wrote a sentence saying "there is none". The state is wrong and the content harmless.
   - **DOC-90** (a manager asks about the approval limit for hiring an external contractor, which I treated as a "the documents do not say" question): the assistant cited the procurement threshold of FIN-BUD-007 and understood "contractor" as "contract procurement". It is an inference with a source, and could also be called going beyond the question; **the question itself is designed ambiguously**, and I cannot say that the assistant was wrong.

### How to read the experiment matrix

- **Noise**: the same configuration (baseline), ingested once in the full evaluation and once in the matrix, gives a hybrid MRR of 0.9713 and 0.9655 and a hit@1 of 0.943 and 0.931: **between two ingestions there is already a difference of about 0.01 in MRR** (small differences in embedding plus ordering by random UUID on ties). A difference under 0.02 must not be taken as an effect.
- **Search mode**: hybrid is no lower than keyword and vector in MRR (0.966 against 0.916 and 0.940); rerank (tested only in the full evaluation) lifts hit@1 on the 87 questions to 1.0.
- **Chunk size** (target 300 / 400 (baseline) / 500 / 800 tokens, chunks 53 / 39 / 30 / 28): the direction of smaller being better: vector's hit@1 is 0.954 at 300 against 0.885 for the baseline (6 more correct out of 87); hybrid 0.954 at 300 against 0.931 (2 more correct, within the noise). This **measures only "which document is found"** and does not measure whether the context in a chunk is enough to generate an answer; smaller chunks also make the cited original passage shorter.
- **The `identifiers` boost** (off vs the baseline, the same ingestion, only the switch changed): under hybrid the MRR of keyword-type questions falls from 1.0 to 0.923 (13 questions) and overall hit@1 from 0.931 to 0.920; **this is the only one that looks like a real effect**, so it stays on. Paraphrase-type questions actually rise from 0.864 to 0.909 (11 questions), which shows that the boost occasionally takes words with no code meaning for codes; the sample is too small and it is left alone.
- **Derived content** (summary / hypothetical questions / all): no clear benefit overall: vector MRR 0.931 to 0.943 (baseline 0.940), hybrid 0.957 to 0.968 (baseline 0.966). By question type paraphrase rises from 0.864 to 0.955 to 1.0 (11 questions), but keyword falls to 0.885 under derive-summary (13 questions). **Conclusion: keep it off by default**; the paraphrase item is worth testing again on more paraphrase questions (there are only 11 now).
- **Not there**: the dedicated rerank interface and the BM25 extension (see section 9 of design 05).

### Leftovers (not done, and not pretended to be done)

- The 20% human spot-check sheet (`answers-20261104-0454.csv`) **has not been looked at by anyone yet**.
- `understand` over-asks for clarification on questions that can be answered directly (4/87); the generate step still occasionally marks `sufficient` when there is no answer (DOC-108). Both are known behaviour problems, and fixing them needs a prompt change and a new evaluation, left for later.
