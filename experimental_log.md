# Experiment Log

## Baseline (2026-04-13)

**Config**: haiku model, 100 questions (all 2-hop), tool mode with MCP search

| Run | F1 | EM | Avg tool calls |
|-----|----|----|----------------|
| baseline 100q | 0.672 | 0.570 | 8.6 |
| baseline 100q run2 | 0.676 | 0.590 | 8.0 |
| **Average** | **0.674** | **0.580** | **8.3** |

Variance: ±0.002 F1 — very stable at 100 questions.

### Failure analysis (from earlier 20-question runs)

Key failure patterns identified:
1. **Retrieval miss** — answer not found after extensive search (17-20 tool calls)
2. **Under-searching** — model gives confident wrong answer after only 3 tool calls
3. **Formatting** — truncated names ("Crockett" vs "Crockett County"), added filler ("promoting European integration")
4. **Inconsistent multi-hop** — right 1/3 times, suggesting retrieval path instability

---

## Experiment 1: H1 — Explicit sub-question decomposition (2026-04-13)

**Hypothesis**: Adding explicit instructions to decompose multi-hop questions into ordered sub-questions before searching should reduce wrong-path errors and under-searching.

**Change**: Rewrote tool-mode prompt in `buildPrompt()` to include decomposition examples and step-by-step instructions.

| Metric | Baseline | H1 | Delta |
|--------|----------|----|-------|
| F1 | 0.674 | 0.655 | -0.019 |
| EM | 0.580 | 0.560 | -0.020 |
| Avg tool calls | 8.3 | 8.1 | -0.2 |

**Result**: Regression. The decomposition instructions likely added overhead for haiku — the model may over-think the meta-reasoning instead of just searching.

**Decision**: Reverted.
