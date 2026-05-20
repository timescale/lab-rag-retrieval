# Top-Tier Results on Hard RAG Benchmarks With a Postgres Table and an Autoresearch Loop

## The Surprising Finding

The RAG field has gone deep on architectural complexity. Knowledge graphs (HippoRAG), hierarchical retrieval (RAPTOR), iterative planning (PAR-RAG), self-critique (Self-RAG), specialized rerankers, fine-tuned retrievers — pick a paper from the last year and you'll find a multi-stage pipeline.

We tried something different. On the two hardest open RAG benchmarks — **MuSiQue** (multi-hop reasoning over Wikipedia) and **BRIGHT** (reasoning-intensive retrieval across 12 domains) — we used the same minimal stack on both:

- One Postgres table per corpus, with BM25 + HNSW indexes
- An MCP tool server giving Claude direct access to hybrid search
- An **autoresearch loop** to find corpus-specific tweaks: hypothesize from failure analysis, implement, eval with paired stats, revert anything that regresses, log either way

That's it. No knowledge graphs. No hierarchical indexing. No retrieval planning pipelines. No fine-tuned models.

The headline numbers:

| Benchmark | Our result | Notes |
|---|---:|---|
| MuSiQue (500 questions) | **0.418 EM / 0.564 Acc** | vs. PAR-RAG 0.33 EM / 0.43 Acc on the same 500-sample setup |
| BRIGHT (12 domains, mean nDCG@10) | **0.556** | Would place 3rd on the [public leaderboard](https://brightbenchmark.github.io/) (mid-May 2026); the only top-3 result without a fine-tuned retriever |

The surprising part isn't that simple architectures can compete — it's that *disciplined methodology beats architectural innovation* on these benchmarks. The autoresearch loop produced two small, targeted classes of optimization for BRIGHT (per-domain prompts and per-doc concept sketches) and explicitly *prevented* us from adding complexity on MuSiQue, where every "improvement" we tried regressed.

The architecture is small. The methodology is what mattered.

## The Foundation

Both benchmarks ran on the same minimal stack.

**Database**: A [Ghost](https://ghost.build) PostgreSQL instance. (Disclosure: this work was done by the team that builds Ghost.) We believe Ghost is best-suited for this type of work for three reasons. First, a generous free tier that makes running these experiments easy and free. Second, it's one of the few hosted providers offering [pg_textsearch](https://github.com/timescale/pg_textsearch) — true BM25 scoring as a native Postgres index. Third, near-instant database forking: any experiment that needed to mutate DB state (new columns, new indexes, re-tagging) ran on a fresh fork that came up in ~1–2 minutes, kept the old DB untouched, and made revert-on-regression a matter of changing one connection string. The forking turned out to be load-bearing for the autoresearch loop described below. The entire schema is a single table with three meaningful columns:

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

## The Autoresearch Loop

The methodology that produced both sets of results. Inspired loosely by Karpathy's autoresearch concept, but with explicit discipline that we found mattered far more than the iteration speed:

**1. Start from failure analysis.** Look at queries where the system underperformed — zero retrieval recall, wrong top-10, bad final answer. Name the failure pattern. Don't propose changes until the pattern is named.

**2. State the hypothesis explicitly.** "If we do X, retrieval recall should move because Y." If you can't state it, you don't understand the failure yet.

**3. Implement the smallest change that tests the hypothesis.** Not a refactor. Not an architectural overhaul. The change should isolate one variable.

**4. Run the eval. Compute paired statistics.** We use paired t-tests *and* sign tests on per-query deltas. Disagreement between them is informative — a metric that's sign-significant but not magnitude-significant is a real but small signal; both insignificant is noise.

**5. Decide: adopted, reverted, or non-viable.** If the change regressed (paired stats either direction), revert the code but **keep the log entry**. The dead-end map matters as much as the kept changes.

**6. Three attempts per hypothesis.** If the first attempt didn't work, identify why and try one more variant. If three variants all fail, declare the hypothesis non-viable and stop. Avoids unbounded chasing of a bad idea.

**7. Log everything.** Adopted changes, reverted changes, non-viable hypotheses. The log is the methodology's output, not just a side effect — it's how future sessions avoid re-trying ideas that already failed.

One piece of infrastructure made the loop fast enough to actually run at this cadence: **cheap database forking on Ghost**. Any change that mutated DB state — adding a column, re-tagging documents, building a new BM25 index over a derived field, ingesting a new corpus — ran on a fresh fork that came up in a minute or two. If the experiment won, we promoted the fork to be the active DB and paused the old one. If it regressed, we paused the new fork and pointed `DATABASE_URL` back at the old one. No state to unwind by hand, no parallel DB instances to maintain. This kept the marginal cost of "let me try X" close to zero, which is what makes a multi-attempt loop work in practice. Without it, the corpus-side experiments on BRIGHT (sketches, new indexes, alternative tagging strategies) would have been prohibitively expensive to iterate on.

The loop's job is to find the optimizations a given corpus actually needs, while preventing the natural temptation to keep adding complexity. The two benchmarks below are case studies of the loop reaching opposite verdicts on the same starting baseline.

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

A dramatically simpler architecture — no knowledge graphs, no hierarchical indexing, no retrieval planning — beats every system in the table. The caveat: we use Claude Haiku (a newer model than Qwen-Plus used in PAR-RAG), so some of the gap likely comes from model capability. But the simplicity gap is real — these complex pipelines may be compensating for limitations of older models that newer ones handle natively.

### Dataset Quality and the Accuracy Estimate

The 500-sample number above is the right comparison against PAR-RAG, but it's not the right answer to "how well does the system actually work." MuSiQue has a non-trivial rate of mechanical-chain dataset errors that score the model wrong even when its reasoning is correct.

MuSiQue constructs multi-hop questions by mechanically chaining single-hop facts, which creates entity-name collisions:

- A paragraph says "Cleveland, Ohio singer-songwriter Eric Carmen" → the expected chain resolves "Cleveland" to Cleveland, North Carolina
- "Atlanta" is identified as Georgia's largest city → the next hop maps it to Atlanta, Michigan

Deep analysis of 4-hop failures revealed several "wrong" answers that were actually more defensible than the ground truth. We documented 6 such dataset errors in our 100-question audited sample (each with the offending paragraph, expected chain, and our reasoning recorded in [`results/dataset-errors.json`](results/dataset-errors.json)). After excluding them — same system, same prompt, same Haiku — the numbers tighten:

| Hops | F1 | EM | Accuracy | Recall | n |
|------|----|----|----------|--------|---|
| 2-hop | 0.670 | 0.579 | 0.737 | 0.921 | 38 |
| 3-hop | 0.478 | 0.326 | 0.535 | 0.837 | 43 |
| 4-hop | 0.482 | 0.421 | 0.474 | 0.816 | 19 |
| **Overall (100q audited)** | **0.552** | **0.440** | **0.600** | **0.865** | **100** |

This is the cleaner read on system quality. The ~6% of questions that are dataset artifacts depress every metric in the 500-sample run by a similar amount, which is what you'd expect if the same artifact rate carries through. Going through every failure in the 500-sample run with the same human-judgment audit would (we expect) recover similar headline numbers — but is laborious enough that the 500-sample result is reported as-is for direct comparison, and the 100-sample audit is reported as the better estimate of the system's actual ability.

### The Loop's Verdict: Every Improvement Hurt

A worthwhile aside on where "the baseline" came from: the foundation we tested against — the single-table schema, hybrid search + RRF, the MCP tool surface, the prompt structure — was itself the output of an autoresearch loop on an earlier project. So when we say we ran the loop on every improvement we could think of, we mean autoresearch on top of autoresearch. Turtles all the way down — though at some point you do have to ingest documents.

The result was humbling:

| Experiment | Impact on F1 |
|-----------|-------------|
| Auto-hybrid search (force both BM25+semantic) | -0.127 |
| Increase results per search (10→20) | -0.092 |
| Add search hints to tool descriptions | -0.142 |
| Entity-enriched content in embeddings | -0.045 |
| Sub-question decomposition prompts | -0.019 |

Every one was reverted. The model (Haiku) is surprisingly good at search out of the box. It naturally uses both semantic and fulltext together (93% of queries use both), adjusts candidate limits when needed, and falls back to grep for exact entity matching. Every attempt to "help" by adding complexity just added noise.

**This is the autoresearch loop's most important output on MuSiQue.** Not a specific optimization that worked — but the systematic ruling-out of a class of ideas. Without the loop, we would have shipped a more complex system that scored lower.

### Schema Simplicity Reduces Token Overhead

Our MCP tool started with 10 parameters (semantic, fulltext, grep, meta, tree, temporal, weights, candidateLimit, limit, order_by). Usage analysis revealed only three matter:

| Parameter | Usage |
|-----------|-------|
| semantic | 96.4% |
| fulltext | 97.8% |
| grep | 4.5% |
| Everything else | <0.5% |

Stripping unused parameters reduced tokens per call — and for a model processing hundreds of tool calls per evaluation, this adds up.

### The Bridge: Retrieval Is Solved, So Where's the Next Bottleneck?

With retrieval recall consistently above 80% (86.5% audited, 81.4% unaudited), the system finds the right paragraphs on MuSiQue most of the time. The gap between retrieval and answer quality is the reasoning step. Improving MuSiQue further is a reasoning problem, not a retrieval problem.

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

The minimal baseline from MuSiQue — Postgres + hybrid + Claude with MCP tools — gets ~0.45 mean nDCG@10 on BRIGHT, capped by retrieval-side vocabulary mismatch. Even with raw queries through BM25 + semantic search + RRF (no agent at all), retrieval recall on robotics tops out around 0.34 — there's a corpus-side ceiling no amount of agent cleverness can break.

The autoresearch loop's job on BRIGHT was to find what *did* work. It discovered two classes of optimization, and ruled out several others.

### Optimization 1: Per-Domain Failure-Mode-Specific Prompts

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

### What the Loop Ruled Out

Equally important: the loop also identified ideas that *didn't* work, with enough discipline that we didn't accumulate cruft from chasing them.

**Stackoverflow: three consecutive prompt experiments, three statistical washes.** We tried (a) encouraging Claude to use grep for canonical API names, (b) requiring a written answer before any search ("answer-first"), and (c) requiring a written answer alongside the ranked IDs ("search-then-answer"). All three measurably changed Claude's tool-call behavior (grep usage 4× higher, tool calls reduced 9→8) but none moved nDCG@10 outside noise. The loop's verdict: stackoverflow's ~0.65 retrieval recall is a corpus-side ceiling that prompt iteration cannot break. The path forward is sketches or an MCP-side change, not more prompt work. Three reverts that would have been three speculative additions without the discipline.

**theoremqa_theorems: opus + specialized prompt = wash.** Statistically indistinguishable from the sonnet baseline on all three metrics (all p > 0.14). Math-domain gold-binding (formal theorem names) already aligns with Opus's training expertise — there was nothing left for the prompt to teach. The loop correctly identified that this domain doesn't benefit from the same reframing that worked elsewhere.

**Minimal system prompt: hypothesis falsified.** We tested whether Claude Code's default system prompt was the bottleneck on stackoverflow by replacing it with a minimal "you are an assistant with tools, use them" instruction. Result: retrieval recall slightly regressed (sign-test p = 0.058). The default system prompt is providing real scaffolding ("be thorough", "explore multiple angles") that helps retrieval. Hypothesis killed; no further work needed in that direction.

**Universal prompts: consistently worse than per-domain.** Saved us from shipping the simpler version that performs worse across the board.

These reverts are part of the same methodology as the wins. The loop's value isn't just the optimizations it discovers — it's the discipline that prevents the system from accumulating ideas that *seemed* like they should help.

### Aggregate Results

Best per-domain results across all 12 BRIGHT domains:

| Domain | nDCG@10 | Config |
|--------|---:|---|
| biology | **0.803** | opus + Wikipedia-concept prompt |
| psychology | 0.654 | opus + Wikipedia-concept prompt |
| theoremqa_questions | 0.614 | sonnet max + math prompt |
| pony | 0.576 | opus + foundational-docs prompt |
| sustainable_living | 0.560 | opus + Wikipedia-concept prompt |
| earth_science | 0.551 | opus + Wikipedia-concept prompt |
| leetcode | 0.522 | opus + foundational-docs prompt |
| robotics | 0.512 | opus + specialized + concept sketches |
| theoremqa_theorems | 0.507 | opus + specialized |
| economics | 0.483 | opus + canonical-source prompt |
| stackoverflow | 0.476 | opus + foundational-docs prompt |
| aops | 0.369 | sonnet xhigh + concept sketches |
| **Mean across 12 domains** | **0.556** | |

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

## Why This Is Surprising

The implicit assumption in the RAG literature is that complex problems need complex architectures. Multi-hop reasoning → add iterative retrieval (IRCoT). Domain knowledge → add a knowledge graph (HippoRAG). Long documents → add hierarchical indexing (RAPTOR). Hard queries → add multi-stage planning (PAR-RAG).

The autoresearch loop reaches a different conclusion. The complex architectures may be compensating for things a simpler stack handles when paired with:

1. **A capable model** — modern Claude (Haiku for MuSiQue, Opus for BRIGHT) handles search-and-reason iteration competently when given access to BM25 + semantic + grep.
2. **Hybrid search with RRF fusion** — the BM25-vs-dense tradeoff matters less when both are available and the model picks. RRF is cheap and effective.
3. **A disciplined search-and-test methodology** — most architectural complexity in the field comes from speculative additions. With a loop that reverts what doesn't work, the system stays simple by default and only grows where there's evidence.

The optimizations the loop *did* discover for BRIGHT — per-domain prompts and concept sketches — are corpus-specific configurations, not architectural innovations. They cost a few hours of diagnostic and tagging work per corpus. Compared to building, training, and maintaining a multi-stage pipeline, they're cheap.

## Conclusion

The architecture that solved both benchmarks is small:

- One Postgres table per corpus
- HNSW + BM25 indexes
- An MCP tool with hybrid search and RRF fusion
- A capable model with direct tool access

The methodology that produced the results is also small, but disciplined:

- Hypothesize from failure analysis
- Implement the smallest change
- Eval with paired stats
- Revert if it regressed; log either way
- Three attempts per hypothesis; declare non-viable if no variant works

The autoresearch loop validated simplicity on MuSiQue (every "improvement" we tried regressed) and discovered two corpus-specific optimization classes on BRIGHT (per-domain prompts, per-doc concept sketches) — same loop, opposite verdicts on the same foundation.

The takeaway: **on these two benchmarks, a Postgres table and a disciplined autoresearch loop competed with much more complex pipelines.** The complex pipelines aren't wrong — they may be the right answer for systems that can't run the loop, or that need a fixed configuration. But if you can iterate, the foundation is enough.

The full code, experiment log, and per-domain methodology notes are available at [repo link].
