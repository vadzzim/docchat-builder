# Local model evaluation

The selected local chat model is `qwen3:0.6b`. This is a small local configuration choice supported by a reproducible comparison; it is not a claim that the model is ready for every production support policy.

## Method

On 2026-09-16, the runner used the three synthetic Northstar Bikes fixtures in `demo/`, the production `splitText` helper (600 UTF-8 bytes with an 80-byte overlap), production `groundedContext`, and real `bge-m3` cosine retrieval. Each question selected the top three chunks at a similarity threshold of 0.35. The same retrieved messages went to both models with no history:

- `qwen3:0.6b` and `qwen2.5:1.5b`.
- Ollama `/api/chat`, `stream: true`, `think: false`, `temperature: 0.1`, `num_ctx: 4096`, `num_predict: 500`.
- `bge-m3` `/api/embed`, `truncate: false`, 1024 dimensions.

Run `npm run test:model` to repeat the direct provider comparison. It writes a timestamped raw report and `test-results/model-comparison-latest.json`; both are ignored local evidence and never replace the canonical manually assessed [question record](docs/model-evaluation.json). The report contains raw answers, retrieval rows, and elapsed times. It is evidence for inspection rather than an automated score.

## Fifteen-question result

The table records the manual assessment of the canonical run. “Correct” means the answer was supported for the question as asked. “Refusal” means the model declined because the fact was absent or, for qwen3 question 4, declined a fact that was present. Full raw wording is in the canonical JSON and the generated raw report.

| # | Question | qwen3:0.6b | qwen2.5:1.5b |
| ---: | --- | --- | --- |
| 1 | What does standard shipping cost and how long does it take? | Correct | Correct |
| 2 | What order value qualifies for free standard shipping? | Correct | Correct |
| 3 | Where does Northstar Bikes ship? | Correct | Correct |
| 4 | Does Northstar Bikes offer expedited or international shipping? | Refusal despite support | Correct |
| 5 | How long do I have to return an unused bike or accessory? | Correct | Correct |
| 6 | How long do refunds take after an approved return? | Correct | Correct |
| 7 | Who pays return shipping for defective and nondefective items? | Omitted the nondefective rule | Reversed the payer rules |
| 8 | What are Northstar Bikes support hours and what does the bike warranty cover? | Omitted the two-year term | Correct |
| 9 | A customer orders a $120 bike in the contiguous United States and later returns it because it is defective. What shipping cost, delivery time, and return-shipping rule apply? | Incorrectly charged $8 instead of applying the free-shipping threshold | Mixed free-threshold and base-charge statements |
| 10 | A customer returns an unused accessory after 20 days. What must they do first, how long does the refund take, and how can they contact support? | Correct | Correct |
| 11 | A customer asks whether expedited shipping is available and wants to return an unused bike after 10 days. What should you tell them? | Incorrectly made nondefective return shipping free | Refused a supported scenario |
| 12 | A customer orders an $80 bike in the contiguous United States and returns it unused after 15 days. What shipping charge and return rules apply? | Contradictory return-payer statements | Incorrectly applied the $100 free-shipping threshold and payer rule |
| 13 | Do you offer local pickup? | Correct refusal | Correct refusal |
| 14 | What is the Northstar support phone number? | Correct refusal | Hallucinated the support email as a phone number |
| 15 | What material are the bike frames made from? | Correct refusal | Correct refusal |

The qwen3 run got most direct facts and all three missing-information cases right, but declined the supported fact in question 4 and made conditional-policy errors. Bracketed inline source markers appeared only in qwen3 answers 1, 2, and 8, and qwen2.5 answer 4; qwen2.5 answer 2 also mentioned SOURCE 1 without brackets. Retrieved source metadata does not prove that the answer accurately used those sources. A later backend fix preserves the model's raw answer and clears metadata citations when an answer ends with the insufficient-information sentinel without an explicit source marker; it does not normalize the answer or add another model call.

## Timing and hardware

The machine had 64 GB RAM and a Quadro T2000 with 4 GiB VRAM. `bge-m3` returned 1024-dimensional vectors. With the desktop included, the observed resident footprint was about 2.1 GiB for bge-m3 plus qwen3, and about 3.3 GiB when all three local models were resident.

Recorded warm provider-only medians were approximately **506 ms** for qwen3 and **856 ms** for qwen2.5. These are chat-provider timings, not full upload, retrieval, Edge Function, or browser journey timings. The selected qwen3 model answered a Russian shipping question in English despite the language instruction, so language matching is best effort and needs a stronger model before a production claim.
