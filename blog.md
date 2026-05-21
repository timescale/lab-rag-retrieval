# RAG Complexity Is a Bet Against the Model: One Postgres Table, Top-Tier MuSiQue + BRIGHT, No Fine-Tuned Retriever

Modern RAG systems grow barnacles. A model misses a multi-hop question, so someone adds a planner. It struggles with vocabulary mismatch, so someone adds a knowledge graph. It ranks the wrong document, so someone adds a reranker. Each addition is reasonable in isolation. Each solves a real failure mode. And each one is a bet that the model will keep needing that help.

That bet gets worse every year. As frontier models improve, work that used to need scaffolding moves back into the model: decomposition, query reformulation, entity disambiguation, deciding when to search again. The weakness can vanish in a single model generation. The complexity built to compensate for it doesn't — months to design and ship, years to maintain. A long-lived tax for a short-lived problem.

We tested the opposite posture: keep the retrieval stack as thin as possible, and make every candidate addition prove — with paired statistics on a real benchmark — that it still earns its place. Two parts matter equally: the thin starting stack, and the loop that keeps it thin. The loop is the part people skip — without it, every failure case becomes an argument for adding something, and you'd ship every one of them.

The thin stack itself fits on two lines:

- One Postgres table per corpus, with BM25 + HNSW indexes
- An MCP tool server giving Claude direct access to hybrid search

That's it. No knowledge graphs. No hierarchical indexing. No retrieval planning pipelines. No fine-tuned retrievers.

On MuSiQue, the loop reverted every "improvement" we tried against this baseline — five consecutive regressions. On BRIGHT, the same loop kept two cheap, removable additions (per-domain prompts, per-doc concept sketches) and rejected the rest. The loop can't predict which additions will age well across model generations — but it can reject the ones that don't help today, which is most of them. For the survivors, the second filter is human judgment about *form*: a prompt is text, a sketch is a column. Both can be deleted when they stop earning.

The headline numbers, on the two hardest open RAG benchmarks:

| Benchmark | Our result | Reference |
|---|---:|---|
| MuSiQue (500q) | **0.418 EM / 0.564 Acc** | PAR-RAG: 0.33 EM / 0.43 Acc |
| BRIGHT (12 domains, mean nDCG@10) | **0.556** | 2nd–3rd rank tier on the [public leaderboard](https://brightbenchmark.github.io/) (mid-May 2026); only result there without a fine-tuned retriever |

> **A thin stack rides the model frontier; a complex pipeline has to be rebuilt to keep up.**

## The Stack

Both benchmarks ran on the same minimal stack.

**Database**: Hosted PostgreSQL on [Ghost](https://ghost.build) (disclosure: built by our team). Two features were load-bearing for the loop: [pg_textsearch](https://github.com/timescale/pg_textsearch) for native BM25 indexes, and near-instant database forking — any DB-mutating experiment could be reverted by switching one connection string. Forking is fast (seconds, not the many hours of dump-and-restore at this corpus size) and free (every fork we spun up fit within Ghost's free plan); without both the time cost and the dollar cost being near-zero, running the loop at this cadence wouldn't have been practical. The entire schema is a single table with three meaningful columns:

```sql
CREATE TABLE corpus (
    id         uuid PRIMARY KEY,
    content    text NOT NULL,
    embedding  halfvec(1536),
    created_at timestamptz NOT NULL DEFAULT now()
);
```

Two indexes:
- **HNSW** (halfvec_cosine_ops) for semantic similarity
- **BM25** (pg_textsearch) for keyword matching

**Retrieval**: An MCP tool server gives Claude one search tool with three search modes:

- **semantic** (string): natural-language query, embedded with OpenAI text-embedding-3-small, matched via HNSW cosine similarity
- **fulltext** (string): keywords for BM25 matching
- **grep** (string): case-insensitive regex for literal entity filtering

When the model passes both semantic and fulltext (it does ~93% of the time on MuSiQue), results are fused using Reciprocal Rank Fusion — each mode contributes a rank-based score, and the top results from the combined ranking are returned. No reranker, no second-pass model, no query planner.

**Reasoning**: Claude iteratively searches the corpus via MCP tool calls. The model decides what to search for, which modes to use, how many results to request, and when to stop. There is no pre-programmed retrieval strategy.

For MuSiQue we used Claude Haiku throughout. For BRIGHT we used Claude Opus on most domains (the reasoning-intensive corpora benefit from a larger model). Same MCP tool, same Postgres schema, same retrieval logic.

That's the starting stack. Out of every experiment the loop ran on either benchmark, the only schema change that survived was a `sketch` column with its own BM25 + HNSW indexes, added on two of BRIGHT's twelve domains — covered in [Case 2](#optimization-2-per-doc-concept-sketches). The rest of the article is about the loop and the two case studies where it reached opposite verdicts on what to add.

## The Loop That Says No

"Stay thin" sounds easy and is hard in practice. Every failure case in the eval looks like an argument for adding something — a planner, a knowledge graph, a reranker. Some of those additions help; most don't, but you can't tell which without testing. The autoresearch loop is the testing discipline: every candidate change must earn its place against paired statistics, and everything that doesn't gets reverted with a logged reason. That's how MuSiQue produced "every improvement hurt" (five reverts) and how BRIGHT landed on two cheap configs rather than a pile of speculative additions. Inspired loosely by Karpathy's autoresearch concept, but with explicit discipline that we found mattered far more than the iteration speed:

**1. Start from failure analysis.** Look at queries where the system underperformed — zero retrieval recall, wrong top-10, bad final answer. Name the failure pattern. Don't propose changes until the pattern is named.

**2. State the hypothesis explicitly.** "If we do X, retrieval recall should move because Y." If you can't state it, you don't understand the failure yet.

**3. Implement the smallest change that tests the hypothesis.** Not a refactor. Not an architectural overhaul. The change should isolate one variable.

**4. Run the eval. Compute paired statistics.** We use paired t-tests *and* sign tests on per-query deltas. Disagreement between them is informative — a metric that's sign-significant but not magnitude-significant is a real but small signal; both insignificant is noise.

**5. Decide: adopted, reverted, or non-viable.** If the change regressed (paired stats either direction), revert the code but **keep the log entry**. The dead-end map matters as much as the kept changes.

**6. Three attempts per hypothesis.** If the first attempt didn't work, identify why and try one more variant. If three variants all fail, declare the hypothesis non-viable and stop. Avoids unbounded chasing of a bad idea.

**7. Log everything.** Adopted changes, reverted changes, non-viable hypotheses. The log is the methodology's output, not just a side effect — it's how future sessions avoid re-trying ideas that already failed.

One piece of infrastructure made the loop fast enough to actually run at this cadence: **cheap database forking**. Any change that mutated DB state — adding a column, re-tagging documents, building a new BM25 index over a derived field, ingesting a new corpus — ran on a fresh fork that came up quickly. If the experiment won, we promoted the fork to be the active DB and paused the old one. If it regressed, we paused the new fork and pointed `DATABASE_URL` back at the old one. No state to unwind by hand, no parallel DB instances to maintain. This kept the marginal cost of "let me try X" close to zero, which is what makes a multi-attempt loop work in practice.

What the loop's verdict looks like in practice: on MuSiQue, "add nothing." The baseline we tested against was itself the output of an earlier autoresearch loop — single-table schema, hybrid + RRF, the MCP tool surface, the prompt structure. Every architectural change we tried against it regressed. Five reverts in a row:

| Experiment | Impact on F1 |
|-----------|-------------|
| Auto-hybrid search (force both BM25+semantic) | -0.127 |
| Increase results per search (10→20) | -0.092 |
| Add search hints to tool descriptions | -0.142 |
| Entity-enriched content in embeddings | -0.045 |
| Sub-question decomposition prompts | -0.019 |

**This is the thesis in miniature.** Each one looked reasonable. Each one regressed. Without the loop's discipline we would have shipped every one and locked ourselves into pipeline complexity to maintain. The loop's most valuable output on MuSiQue isn't a kept change — it's five reverted ones.

On BRIGHT, the same loop reached the opposite verdict — kept two cheap, removable additions (per-domain prompts and per-doc sketches) and rejected the rest. Same loop, opposite verdicts. The two case studies below cover the why and the how.

## Case 1: MuSiQue — When the Loop Says "Stay Simple"

[MuSiQue](https://github.com/StonyBrookNLP/musique) is a multi-hop reading comprehension benchmark with 2,417 dev questions spanning 2, 3, and 4-hop reasoning chains. Each question is constructed by composing single-hop questions, where each hop genuinely depends on the previous — no shortcuts. The corpus contains 139,416 Wikipedia paragraphs.

Example 4-hop question:
> "What is the capital of the county that shares a border with the county that contains the birthplace of Erik Jensen?"
>
> Chain: Erik Jensen → born in Appleton → Outagamie County → borders Brown County → capital is Green Bay

### Results

We evaluated on 500 random questions (seeded for reproducibility) covering all hop types. Sample matches the methodology used by [PAR-RAG](https://arxiv.org/abs/2504.16787) so the comparison below is apples-to-apples on sample size and methodology:

| Hops | F1 | EM | Accuracy | Recall | n |
|------|----|----|----------|--------|---|
| 2-hop | 0.617 | 0.485 | 0.636 | 0.835 | 239 |
| 3-hop | 0.539 | 0.400 | 0.558 | 0.848 | 165 |
| 4-hop | 0.351 | 0.281 | 0.396 | 0.703 | 96 |
| **Overall** | **0.540** | **0.418** | **0.564** | **0.814** | **500** |

EM is the strictest metric — character-for-character identical to gold. F1 measures token overlap. Accuracy uses an LLM judge to evaluate semantic equivalence (catching cases like "16" ≈ "sixteen", "south" ≈ "meanders slowly southwards"). Recall is the fraction of ground-truth supporting paragraphs the system retrieved.

For context, here's how this compares to results reported in [PAR-RAG](https://arxiv.org/abs/2504.16787) (Table 3, revised January 2026), one of the latest papers on multi-hop RAG. PAR-RAG benchmarks several RAG approaches on MuSiQue using Qwen-Plus on a comparable 500-sample setup (different model from our Haiku, same sample size):

| System | EM | Acc | Notes |
|--------|-----|-----|-------|
| Standard RAG | 0.08 | 0.08 | Baseline |
| RAPTOR | 0.06 | 0.12 | Hierarchical retrieval |
| IRCoT | 0.31 | 0.35 | Iterative retrieval |
| HippoRAG w/ IRCoT | 0.30 | 0.42 | + knowledge graph |
| ReAct | 0.15 | 0.36 | Agent-based reasoning |
| Self-Ask | 0.13 | 0.24 | Iterative decomposition |
| PAR-RAG | 0.33 | 0.43 | Plan-driven decomposition |
| **Ours (Postgres + Haiku)** | **0.418** | **0.564** | Single table, hybrid search, MCP tools |

A dramatically simpler architecture — no knowledge graphs, no hierarchical indexing, no retrieval planning — outscores every system in the table. Each row above was built against an older model's limitations; a stronger model on a thin stack captures most of what those pipelines were designed to provide — at a fraction of the maintenance footprint.

### Dataset Quality and the Accuracy Estimate

The 0.564 headline above is depressed by errors in MuSiQue's gold answers. The benchmark constructs multi-hop questions by mechanically chaining single-hop facts, which produces entity-name collisions: "Cleveland, Ohio" resolves to Cleveland, North Carolina in the expected chain; "Atlanta" as Georgia's largest city maps to Atlanta, Michigan next hop. We audited failures in a 100-question sample and found 6 cases where the system's answer was more defensible than gold. Excluding them lifts overall accuracy to 0.600, which we believe is the more accurate read of the system's actual performance ([per-error reasoning in `results/dataset-errors.json`](results/dataset-errors.json)).

We report 0.564 as the headline because it's the apples-to-apples comparison against PAR-RAG. The audit was failure-only and team-judged, so the specific calls are open to second-guessing — but the error rate likely carries through the 500-sample run, so the gap between measured score and true performance is real and roughly uniform.

### Bridge: From Retrieval to Reasoning

Retrieval on MuSiQue is mostly handled — partly because the corpus permits it, and partly because Haiku already knows how to search. The model uses both semantic and fulltext together on 93% of queries, adjusts candidate limits when initial searches come back too narrow, and falls back to grep for exact entity matching. The combination produces retrieval recall above 80% at every hop depth on the audited set (0.92 / 0.84 / 0.82 on 2-, 3-, 4-hop). Accuracy falls more steeply (0.74 / 0.54 / 0.47). Even on 4-hop, the system finds the supporting paragraphs most of the time — it just can't always compose the answer. The remaining gap is mostly a reasoning problem, not a retrieval one.

But what happens when **retrieval itself** is the bottleneck — when the query and the gold document use entirely different vocabulary? That's where BRIGHT comes in.

## Case 2: BRIGHT — When the Loop Discovers Corpus-Specific Optimizations

[BRIGHT](https://arxiv.org/abs/2407.12883) is a more recent benchmark designed specifically to break retrieval systems that rely on surface-level overlap. Twelve separate corpora, each with its own queries, each scored by nDCG@10. The query/gold pairs come from real venues (Stack Exchange, AoPS, Reddit, GitHub) and the gold-labeling rule is "what an expert answer would actually cite." This produces a very specific failure mode: the query uses everyday or stuck-user phrasing while the gold document uses formal, canonical vocabulary.

| Domain | Query phrasing | Gold document |
|--------|----------------|---------------|
| biology | "Why do I only breathe out of one nostril?" | Wikipedia "Nasal cycle" |
| psychology | "Term for inability to see past current emotional state?" | Wikipedia "Hot-cold empathy gap" |
| stackoverflow | "Is there a melt command in Snowflake?" | Snowflake SQL UNPIVOT reference |
| robotics | "Subscriber in hardware interface" | ros2_control `TopicBasedSystem` API reference |
| economics | "Samsung's contribution to South Korea's GDP" | ASC 606 revenue recognition accounting standard |
| aops | "Mary baking 10 cookies of 3 shapes, distribute diversely" | ProofWiki "Pigeonhole Principle" theorem |

BRIGHT's headline metric is nDCG@10 (a standard ranking-quality score for the final top-10 returned per query). We also track two diagnostic metrics throughout this section:

- **Retrieval recall**: of all the gold documents for a query, what fraction did the agent *see* in any tool-call result during its search — regardless of whether they ended up in the final ranking. Measures the retrieval-side question: did the agent's searches surface the right docs at all?
- **Ranking recall**: of all the gold documents, what fraction made it into the final top-10. Measures the ranking-side question: of the docs the agent saw, did it rank the right ones highly?

The distinction matters: an experiment can move retrieval recall (the agent sees more gold) without moving ranking recall (the agent ranks the same), and vice versa. We'll see both patterns below.

The minimal baseline from MuSiQue — Postgres + hybrid + Claude with MCP tools — gets ~0.45 mean nDCG@10 on BRIGHT, capped by retrieval-side vocabulary mismatch. Even with raw queries through BM25 + semantic search + RRF (no agent at all), retrieval recall on robotics tops out around 0.34 — there's a corpus-side ceiling no amount of agent cleverness can break.

The autoresearch loop's job on BRIGHT was to find what *did* work. It discovered two classes of optimization, and ruled out several others.

### Optimization 1: Per-Domain Failure-Mode-Specific Prompts

A note on "per-domain" before the details: in any real production RAG system you're building for *one* corpus — a single product's docs, a single research domain, a single customer support knowledge base. You'd naturally write a prompt tuned to what that corpus looks like, because the agent benefits from knowing what kind of document it's searching across. The unusual thing in this benchmark setup isn't writing per-domain prompts; it's that BRIGHT bundles 12 unrelated corpora into one evaluation and implicitly invites a generic prompt that has to handle all of them at once. A generic prompt does worse on every domain we tested. What follows is what we'd do in any real deployment, applied 12 times.

For each domain, we looked at queries with zero retrieval recall and named the gold archetype. Five distinct shapes emerged:

| Gold archetype | Domains |
|---|---|
| Foundational language/runtime docs (NOT framework helpers) | pony, leetcode |
| Wikipedia article on the underlying concept | biology, psychology, earth_science, sustainable_living |
| Canonical academic source (NBER/IMF/textbook chapter) | economics |
| Official API reference (NOT tutorial or framework wrapper) | stackoverflow, robotics |
| Named formal theorem the story-wrapped problem reduces to | aops, theoremqa_theorems |

Each domain got a prompt that told Claude what gold *looked like* in that corpus, with concrete examples drawn from the actual gold IDs. The prompt also told Claude what to *avoid* searching for — framework keywords from training, story-specific surface entities, error-message phrasing.

Same model, same retrieval infrastructure. The prompt was the only variable.

The wins were large where Opus's training had been steering it toward the *wrong* gold level:

| Domain | Before | After | Δ nDCG@10 | Significant? |
|--------|---:|---:|---:|---|
| pony | 0.329 | **0.576** | +0.247 | p < 0.001 |
| leetcode | 0.370 | **0.522** | +0.152 | p < 0.001 |
| biology | 0.666 | **0.803** | +0.137 | p < 0.001 |
| earth_science | 0.459 | **0.551** | +0.092 | p < 0.001 |
| psychology | 0.570 | **0.654** | +0.084 | p = 0.003 |
| sustainable_living | 0.488 | **0.560** | +0.072 | p = 0.008 |

A universal one-size-fits-all prompt we A/B tested first underperformed the per-domain prompts by 5–25 nDCG@10 points on every domain. The diagnostic effort (look at zero-recall queries → identify why gold was missed → name the archetype) was the one-time cost per domain that the loop produced.

**A methodology note.** BRIGHT ships no train/dev/test split, and we wrote each archetype prompt by inspecting zero-recall queries on the same set we then re-scored — strictly speaking, test-set tuning. Two reasons we think the wins are genuine retrieval improvement rather than fitting: the prompts name corpus-level archetypes ("Wikipedia article on the concept", "official API reference NOT tutorial") rather than per-query gold, and the gains concentrate on retrieval recall — a corpus-level vocabulary-bridge effect, not a per-query ranking one. The universal-prompt A/B above rules out "any prompt change helps." A held-out random-split validation would be stricter and we didn't do one.

### Optimization 2: Per-Doc Concept Sketches

On robotics, even with the right prompt and the right model, retrieval recall plateaued at 0.527 — and 59% of queries had at least one gold doc *never appearing* in any tool-call result set. We ran `probe_robotics_raw.ts` to compute the upper bound: raw user queries through BM25 + semantic + RRF at top-100 maxed out at retrieval recall 0.335. The vocabulary ceiling was real and corpus-side.

The fix: generate an 80–120-word **concept sketch** for every document, designed to bridge both vocabularies. A sketch on the `image_proc` rectify documentation, for example, would explicitly contain:
- The canonical API names (`rectify`, `image_rect`, `camera_info`, `ApproximateTimeSynchronizer`)
- The user-symptom phrasing a stuck developer would actually type (`distorted camera images`, `undistorting images before yolo/detection`, `weird warping in rviz`)
- Adjacent/alternative packages (`cv_bridge`, `image_view`, `image_transport`)

Sketches go into their own `sketch` column with their own BM25 and HNSW indexes. The MCP server detects the sketch column at startup and switches from 2-way RRF (content BM25 + content semantic) to **4-way RRF** (content BM25 + sketch BM25 + content semantic + sketch semantic).

The mechanism: a query in user-symptom vocabulary still hits the sketch indexes even if it misses the formal-vocabulary content indexes. The doc gets surfaced; the agent can then reason on the actual content.

Result on robotics (101 queries, paired stats):

| Metric | No sketches | With sketches | Δ |
|--------|---:|---:|---:|
| nDCG@10 | 0.458 | **0.512** | +0.054 |
| Retrieval recall | 0.527 | **0.594** | +0.067 (sign test p = 0.014) |
| Ranking recall | 0.480 | **0.520** | +0.040 |

A similar sketch enrichment on aops produced +0.053 retrieval recall (p = 0.017). Both wins are retrieval-recall driven, which is exactly the bottleneck the sketches were designed to break.

Sketches cost time and tokens (we tagged the robotics corpus at ~62k docs over ~6 hours using Claude Haiku, with the recipe explicitly designed to be resumable across rate-limit windows). The cost is one-time per corpus.

Sketches are also disposable in the sense that matters most for the thin-stack thesis: a sketch is text in a column. When the next model bridges user-symptom vocabulary to formal API vocabulary on its own, we drop the column and the 4-way RRF falls back to 2-way. No pipeline to retire, no retriever to retrain. The same is true of the per-domain prompts — a prompt is a string. The optimizations the loop adopts are explicitly the kind that can be deleted, not the kind that get baked into infrastructure.

### What the Loop Ruled Out

Equally important: the loop also identified ideas that *didn't* work, with enough discipline that we didn't accumulate cruft from chasing them.

**Stackoverflow: three consecutive prompt experiments, three statistical washes.** We tried (a) encouraging Claude to use grep for canonical API names, (b) requiring a written answer before any search ("answer-first"), and (c) requiring a written answer alongside the ranked IDs ("search-then-answer"). All three measurably changed Claude's tool-call behavior (grep usage 4× higher, tool calls reduced 9→8) but none moved nDCG@10 outside noise. The loop's verdict: stackoverflow's ~0.65 retrieval recall is a corpus-side ceiling that prompt iteration cannot break. The path forward is sketches or an MCP-side change, not more prompt work. Three reverts that would have been three speculative additions without the discipline.

**theoremqa_theorems: opus + specialized prompt = wash.** Statistically indistinguishable from the sonnet baseline on all three metrics (all p > 0.14). Math-domain gold-binding (formal theorem names) already aligns with Opus's training expertise — there was nothing left for the prompt to teach. The loop correctly identified that this domain doesn't benefit from the same reframing that worked elsewhere.

**Minimal system prompt: hypothesis falsified.** We tested whether Claude Code's default system prompt was the bottleneck on stackoverflow by replacing it with a minimal "you are an assistant with tools, use them" instruction. Result: retrieval recall slightly regressed (sign-test p = 0.058). The default system prompt is providing real scaffolding ("be thorough", "explore multiple angles") that helps retrieval. Hypothesis killed; no further work needed in that direction.

**Universal prompts: consistently worse than per-domain.** Saved us from shipping the simpler version that performs worse across the board.

These reverts are part of the same methodology as the wins. The loop's value isn't just the optimizations it discovers — it's the discipline that prevents the system from accumulating ideas that *seemed* like they should help.

### Aggregate Results

Best per-domain results across all 12 BRIGHT domains:

| Domain | nDCG@10 | Retrieval recall | Ranking recall | Config |
|--------|---:|---:|---:|---|
| biology | **0.803** | 0.825 | 0.831 | opus + Wikipedia-concept prompt |
| psychology | 0.654 | 0.731 | 0.636 | opus + Wikipedia-concept prompt |
| theoremqa_questions | 0.614 | 0.773 | 0.711 | sonnet max + math prompt |
| pony | 0.576 | 0.581 | 0.283 | opus + foundational-docs prompt |
| sustainable_living | 0.560 | 0.711 | 0.593 | opus + Wikipedia-concept prompt |
| earth_science | 0.551 | 0.639 | 0.557 | opus + Wikipedia-concept prompt |
| leetcode | 0.522 | 0.575 | 0.527 | opus + foundational-docs prompt |
| robotics | 0.512 | 0.595 | 0.527 | opus + specialized + concept sketches |
| theoremqa_theorems | 0.507 | 0.761 | 0.669 | opus + specialized |
| economics | 0.483 | 0.660 | 0.474 | opus + canonical-source prompt |
| stackoverflow | 0.476 | 0.629 | 0.554 | opus + foundational-docs prompt |
| aops | 0.369 | 0.652 | 0.446 | sonnet xhigh + concept sketches |
| **Mean across 12 domains** | **0.556** | **0.678** | **0.567** | |

For context, here's where this lands on the public [BRIGHT leaderboard](https://brightbenchmark.github.io/) (Short Document track, nDCG@10 mean across 12 domains, as of mid-May 2026):

| Rank | System | nDCG@10 | Approach |
|---|---|---:|---|
| 1 | Mira-Reasoning-Retrieval (Forward AI Labs) | 0.669 | Specialized retriever |
| 2 | INF-X-Retriever (INF) | 0.634 | Specialized retriever |
| **—** | **Ours: Postgres + hybrid + autoresearch loop** | **0.556** | **Off-the-shelf retrievers + agent** |
| 3 | RakanEmbed4B (RakanLabs) | 0.524 | Specialized retriever (fine-tuned embedding) |
| 4 | NeMo Retriever's Agentic Retrieval (NVIDIA) | 0.509 | Agentic |
| 5 | DIVER-v3-GroupRank (Ant Group / SYSU) | 0.468 | Specialized retriever + reranker |
| 6 | BGE-Reasoner-0928 (BAAI) | 0.464 | Reasoning-tuned retriever |

Two things stand out. First, **every system at or above our score uses a specialized retriever** — Mira, INF-X, and RakanEmbed4B all fine-tune an embedding model on reasoning-intensive data. Our system uses OpenAI's general-purpose `text-embedding-3-small` and pg_textsearch BM25, both off the shelf. The only "specialization" happens at prompt and (for two domains) corpus-sketch time, both produced by the autoresearch loop.

Second, against the only other agentic system on the board — NVIDIA's NeMo Retriever Agentic Retrieval at 0.509 — we're +0.047. Same general approach (agent with retrieval tools), different methodology for getting the agent to perform: NVIDIA's full retrieval stack vs our Postgres + hybrid + loop-discovered tweaks.

This was the second surprising finding. The leaderboard's top tier is dominated by training-based approaches, and we sit in the middle of it with a system with no task-specific training.

## What This Costs

Thin at build time, expensive at inference time. The honest case for the thin-stack thesis has to own this.

**Per query** (measured via `claude -p` invocations through the same MCP server and prompts as the headline eval; full methodology in `blog_cost_calcs.md`):

| Setup | $/query | wall sec | mean tool calls |
|---|---:|---:|---:|
| BRIGHT, Opus max (10 of 12 domains) | ~$0.65 | ~30 | 10–12 |
| BRIGHT, Sonnet xhigh (aops, theoremqa_questions) | ~$0.34 | ~70 | 17 |
| MuSiQue, Haiku | ~$0.09 | ~77 | 11 |

A specialized retriever (Mira-class, BGE-class) runs ~$0.0001 per query at <1s latency — roughly **6,500× cheaper, 30× faster** than our agent loop. But the retriever carries a training cost the agent loop doesn't: ~$10K–$100K to fine-tune a ~500M-param reasoning-aware embedding model, amortized over 100K–10M queries before the next retrain.

With $50K training amortized over N queries, the retriever's total cost equals our $0.65/query when N ≈ 77K. Below that, the agent loop is cheaper on total cost; above it, the retriever wins. A 1,384-query benchmark sits well below; a 100K-queries/month customer support system sits well above.

**The crossover moves each model generation.** Per-token inference cost has fallen ~10× per 12–18 months at each capability tier — Haiku 4.5 today handles work that needed Sonnet 3.5 a year ago at a fraction of the per-token cost. A specialized retriever is already near the floor of model inference economics and doesn't track new model generations without retraining. Project forward: crossover at ~77K queries today, ~500K in 18 months, ~2.5M in 3 years. Each generation, more workloads land on the agent-loop side.

Whether per-token prices keep compressing at this rate is a prediction, not a finding. The cost is real today; the trajectory is the case for treating it as a near-term tax rather than a structural disadvantage.

## The Bitter Lesson Comes for RAG

A thin stack rides the model frontier; a complex pipeline has to be rebuilt to keep up. That's Sutton's bitter lesson, applied to retrieval. Four concrete shapes that takes here:

1. **The thin stack is already competitive.** A capable model + hybrid search + RRF + an agent loop matches or beats most of the complex pipelines on both benchmarks today. Most architectural complexity in the literature was solving for yesterday's model.

2. **The thin stack carries less debt forward.** When the next model lands, our stack is one Postgres table and an MCP tool. The new model plugs into the same primitives and is immediately better at using them. A knowledge graph, a hierarchical index, a fine-tuned retriever: each gets re-justified against the new model's baseline, and often torn down.

3. **What structure remains is portable across models.** Hybrid search, RRF, the tool-using agent loop itself — these aren't bets on the current model's weaknesses. They're primitives a stronger model uses better. That's the kind of structure worth keeping; the rest is the kind worth defending against with a loop.

4. **Cost rides the frontier downward too.** Per-token inference cost has fallen ~10× per 12–18 months at each capability tier. A fine-tuned retriever's per-token cost is already near the floor and its capability is frozen at training time. The crossover where retrieval beats the agent loop on total cost moves upward each model generation — quantified in *What This Costs* above.

The optimizations the loop did adopt on BRIGHT — per-domain prompts, per-doc sketches — are explicitly the removable kind. A prompt is text. A sketch is a column. When they stop earning their keep, you delete them. None of it is architectural commitment.

What's prediction vs finding here: the thin stack already being competitive on quality in 2026 is the finding. Winning on quality, maintenance, and cost over the next few model generations is the prediction. We're betting on it.

## Conclusion

The takeaway isn't that we beat a leaderboard. It's a posture for building RAG systems in a regime where the model is improving faster than your pipeline can. **RAG complexity is a bet against the model.** Most architectural additions in the field compensate for a specific model's specific weaknesses and become overhead the moment the weakness goes away. A thin stack — one Postgres table, hybrid search + RRF, an agent loop, and a disciplined autoresearch loop to revert what doesn't help — rides the frontier instead.

The loop validated that posture on MuSiQue (every "improvement" regressed) and adopted two cheap, removable optimization classes on BRIGHT (per-domain prompts, per-doc concept sketches). Same loop, opposite verdicts, same underlying logic: stay thin by default.

If the bet is right, every pipeline built for yesterday's model becomes someone's maintenance burden. If it's wrong, the cost of being wrong is a Postgres table and a prompt.

The full code, experiment log, and per-domain methodology notes are available at [repo link].
