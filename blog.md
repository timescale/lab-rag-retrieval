# Top-Tier Results on Hard RAG Benchmarks With One Postgres Table

## RAG Complexity Is a Bet Against the Model

The RAG field has gone deep on architectural complexity. Knowledge graphs (HippoRAG), hierarchical retrieval (RAPTOR), iterative planning (PAR-RAG), self-critique (Self-RAG), specialized rerankers, fine-tuned retrievers — pick a paper from the last year and you'll find a multi-stage pipeline.

Most of that complexity exists to compensate for things the model can't do on its own. Multi-hop reasoning gets pushed into a planner because the base model isn't good enough at decomposition. Vocabulary mismatch gets pushed into a knowledge graph because the base model can't bridge it. Each scaffold was a reasonable answer to a real limitation at the time. The problem is that the limitations move and the scaffolds don't — the planner built for a 2024 model is still a planner to maintain after the 2026 model decomposes natively. Complexity outlives the problem it was designed for.

We tried the inverse. On the two hardest open RAG benchmarks — **MuSiQue** (multi-hop reasoning over Wikipedia) and **BRIGHT** (reasoning-intensive retrieval across 12 domains) — we used the same minimal stack on both:

- One Postgres table per corpus, with BM25 + HNSW indexes
- An MCP tool server giving Claude direct access to hybrid search
- An **autoresearch loop** whose job is not to add sophistication but to *prevent* it: hypothesize from failure analysis, implement, eval with paired stats, revert anything that regresses, log either way

That's it. No knowledge graphs. No hierarchical indexing. No retrieval planning pipelines. No fine-tuned models.

The headline numbers:

| Benchmark | Our result | Notes |
|---|---:|---|
| MuSiQue (500 questions) | **0.418 EM / 0.564 Acc** | vs. PAR-RAG 0.33 EM / 0.43 Acc on a comparable 500-sample setup; we ran Haiku, PAR-RAG ran Qwen-Plus, so this conflates model with architecture — see below |
| BRIGHT (12 domains, mean nDCG@10) | **0.556** | Comparable to the 2nd–3rd rank tier on the [public leaderboard](https://brightbenchmark.github.io/) (mid-May 2026); the only result in that tier without a fine-tuned retriever |

**A thin stack rides the model frontier; a complex pipeline has to be rebuilt to keep up.** Today the thin stack is already competitive on quality, expensive at inference. The bet is that "today" keeps moving and the stack doesn't have to.

## The Foundation

Both benchmarks ran on the same minimal stack.

**Database**: A [Ghost](https://ghost.build) PostgreSQL instance. (Disclosure: this work was done by the team that builds Ghost.) We believe Ghost is best-suited for this type of work for three reasons. First, a generous free tier that makes running these experiments easy and free. Second, it's one of the few hosted providers offering [pg_textsearch](https://github.com/timescale/pg_textsearch) — true BM25 scoring as a native Postgres index. Third, near-instant database forking: any experiment that needed to mutate DB state (new columns, new indexes, re-tagging) ran on a fresh fork that came up in 10s of seconds, kept the old DB untouched, and made revert-on-regression a matter of changing one connection string. The forking turned out to be load-bearing for the autoresearch loop described below. The entire schema is a single table with three meaningful columns:

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

"Stay thin" sounds easy and is hard in practice. Every failure case in the eval looks like an argument for adding something — a planner, a knowledge graph, a reranker. Some of those additions help; most don't, but you can't tell which without testing. The autoresearch loop is the testing discipline: every candidate change must earn its place against paired statistics, and everything that doesn't gets reverted with a logged reason. That's how MuSiQue produced "every improvement hurt" (five reverts) and how BRIGHT landed on two cheap configs rather than a pile of speculative additions. Inspired loosely by Karpathy's autoresearch concept, but with explicit discipline that we found mattered far more than the iteration speed:

**1. Start from failure analysis.** Look at queries where the system underperformed — zero retrieval recall, wrong top-10, bad final answer. Name the failure pattern. Don't propose changes until the pattern is named.

**2. State the hypothesis explicitly.** "If we do X, retrieval recall should move because Y." If you can't state it, you don't understand the failure yet.

**3. Implement the smallest change that tests the hypothesis.** Not a refactor. Not an architectural overhaul. The change should isolate one variable.

**4. Run the eval. Compute paired statistics.** We use paired t-tests *and* sign tests on per-query deltas. Disagreement between them is informative — a metric that's sign-significant but not magnitude-significant is a real but small signal; both insignificant is noise.

**5. Decide: adopted, reverted, or non-viable.** If the change regressed (paired stats either direction), revert the code but **keep the log entry**. The dead-end map matters as much as the kept changes.

**6. Three attempts per hypothesis.** If the first attempt didn't work, identify why and try one more variant. If three variants all fail, declare the hypothesis non-viable and stop. Avoids unbounded chasing of a bad idea.

**7. Log everything.** Adopted changes, reverted changes, non-viable hypotheses. The log is the methodology's output, not just a side effect — it's how future sessions avoid re-trying ideas that already failed.

One piece of infrastructure made the loop fast enough to actually run at this cadence: **cheap database forking on Ghost**. Any change that mutated DB state — adding a column, re-tagging documents, building a new BM25 index over a derived field, ingesting a new corpus — ran on a fresh fork that came up quickly. If the experiment won, we promoted the fork to be the active DB and paused the old one. If it regressed, we paused the new fork and pointed `DATABASE_URL` back at the old one. No state to unwind by hand, no parallel DB instances to maintain. This kept the marginal cost of "let me try X" close to zero, which is what makes a multi-attempt loop work in practice. Without it, the corpus-side experiments on BRIGHT (sketches, new indexes, alternative tagging strategies) would have been prohibitively expensive to iterate on.

The two benchmarks below are case studies of the loop reaching opposite verdicts on the same starting baseline. On MuSiQue the loop will tell us to add nothing — every change regressed; the simple stack was already at the model's ceiling. On BRIGHT it will tell us to add two cheap, removable things (per-domain prompts and per-doc sketches) and to leave the schema and retrieval stack untouched. Same loop, opposite verdicts, same underlying logic: only adopt what the next model won't make embarrassing.

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

A dramatically simpler architecture — no knowledge graphs, no hierarchical indexing, no retrieval planning — outscores every system in the table. The honest caveat: we ran Claude Haiku and PAR-RAG ran Qwen-Plus, so this number conflates model capability with architecture. We cannot cleanly separate the two from this data alone. Under the thin-stack thesis, the confound is part of the finding: each row above represents complexity designed against an older model's limitations, and a newer model handles those cases natively. A thin stack on a newer model captured most of what each pipeline was designed to provide — at a fraction of the maintenance footprint.

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

Two honest caveats on this audit: it was failure-only — we didn't review successes for analogous false-positives where the system "got it right" for the wrong reason — and it was team-judged, not blinded. The per-error reasoning is recorded in [`results/dataset-errors.json`](results/dataset-errors.json) (offending paragraph, expected chain, our reasoning), so the specific calls are open to second-guessing — but the judgment is still ours.

The ~6% of questions that are dataset artifacts depress every metric in the 500-sample run by a similar amount, which is what you'd expect if the same artifact rate carries through. Going through every failure in the 500-sample run with the same human-judgment audit would (we expect) recover similar headline numbers — but is laborious enough that the 500-sample result is reported as-is for direct comparison.

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

**This is exactly the thin-stack thesis in miniature.** Every architectural addition we tried was overhead the current model didn't need. Without the loop's discipline, we would have shipped each of them, scored lower, and locked ourselves into pipeline complexity to maintain going forward. The loop's most valuable output on MuSiQue isn't a kept change — it's five reverted ones.

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

We measured per-query cost on the actual configuration by running real `claude -p` invocations through the same MCP server and prompts the headline eval used, capturing `total_cost_usd` and `usage` from claude's result event. Full methodology in `blog_cost_calcs.md`.

**Per query:**

| Setup | $/query | wall sec | mean tool calls |
|---|---:|---:|---:|
| BRIGHT, Opus max (10 of 12 domains) | ~$0.65 | ~30 | 10–12 |
| BRIGHT, Sonnet xhigh (aops, theoremqa_questions) | ~$0.34 | ~70 | 17 |
| MuSiQue, Haiku | ~$0.09 | ~77 | 11 |

**Per full eval run:**

- BRIGHT 12 domains, 1,384 queries: ~$890, ~70 min wall clock (concurrency 10)
- MuSiQue 500 questions: ~$46, ~2 hr wall clock (concurrency 5)

**Compared to a specialized retriever** (Mira-class, BGE-class — forward pass through a fine-tuned embedding model):

| | $/query inference | latency | training |
|---|---:|---:|---:|
| Our agent loop (BRIGHT, Opus max) | ~$0.65 | ~30s | none |
| Fine-tuned retriever | ~$0.0001 | <1s | $10K–$100K |

Per-query inference is roughly **6,500× cheaper, 30× faster** for the specialized retriever. But the per-query gap isn't the whole comparison — the retriever has a training cost that the agent loop doesn't.

Fine-tuning a ~500M-param reasoning-aware embedding model on the kind of data Mira / BGE-Reasoner / RakanEmbed are trained against runs on the order of $10K–$100K of GPU time, depending on dataset size and how many ablation runs you actually do before shipping. That cost amortizes over the queries served before the next retrain. Retrain triggers include: a new frontier model lands and you want to refresh against its embeddings; the corpus shifts (new docs, new domains added); or accumulated drift makes the existing model stale on production traffic. Realistic windows are 100K–10M queries between retrains.

The crossover at our per-query cost: with $50K training amortized over N queries, total cost per query for the specialized retriever is $0.0001 + $50K/N. That equals our $0.65/query when N ≈ 77K queries. Below ~77K queries between retrains, the agent loop is cheaper on total cost. Above it, the retriever wins.

A 1,384-query benchmark sits well below — training never pays back at this scale. A customer-support system serving 100K queries/month sits well above — training pays back in a few weeks. Which side of crossover you're on depends on traffic and retrain cadence; both are case-specific.

**Both the per-query gap and the crossover point are moving.** The numbers above are static — today's prices, today's capabilities. They're not the trajectory.

Per-token inference cost has fallen roughly an order of magnitude every 12–18 months at each capability tier, as smaller models absorb what previously needed bigger ones. Haiku 4.5 today handles work that needed Sonnet 3.5 a year ago at a fraction of the per-token cost. If that pattern holds, the same BRIGHT-style workload that runs at $0.65/query on Opus today plausibly runs at ~$0.10/query in 18 months and ~$0.02 in 3 years.

A specialized retriever has the opposite trajectory. Its per-token cost is already near the floor of model inference economics — it can only get cheaper through commodity GPU price compression, which moves slower than frontier inference prices. Its *capability* is frozen at training time and doesn't track new model generations at all without retraining.

Plug the projected per-query cost into the crossover formula: at today's $0.65, breakeven is ~77K queries between retrains. At $0.10 in 18 months, ~500K queries. At $0.02 in 3 years, ~2.5M queries. Each model generation, more workloads move into the "agent loop wins on total cost" side of the line.

This trajectory is the second half of the thin-stack bet on cost. Whether per-token prices keep compressing at the rate the last few generations suggest is a prediction, not a finding.

The cost is real today; the trajectory is the case for treating it as a near-term tax rather than a structural disadvantage. The next section places this alongside the quality and maintenance arguments for the thin stack.

## The Bitter Lesson Comes for RAG

The RAG literature's implicit assumption: complex problems need complex architectures. Multi-hop reasoning → add iterative retrieval (IRCoT). Domain knowledge → add a knowledge graph (HippoRAG). Long documents → add hierarchical indexing (RAPTOR). Hard queries → add multi-stage planning (PAR-RAG).

Each scaffold was a reasonable answer to a real model limitation at the time. The problem is that limitations move and scaffolds don't. A planner built for a 2024 model's decomposition weakness is still a planner — to maintain, to debug, to integrate — after the 2026 model decomposes natively. The complexity outlives the problem it was designed for.

This is Sutton's bitter lesson applied to retrieval: methods that ride model improvement beat methods that bake in fixed structure. Four concrete shapes that takes here:

1. **The thin stack is already competitive.** A capable model + hybrid search + RRF + an agent loop matches or beats most of the complex pipelines on both benchmarks today. Whether it strictly wins model-for-model we can't fully prove from these numbers (the PAR-RAG comparison is confounded), but the *direction* is clear: most architectural complexity in the literature was solving for yesterday's model.

2. **The thin stack carries less debt forward.** When the next model lands, our stack is one Postgres table and an MCP tool. The new model plugs into the same primitives and is immediately better at using them. A knowledge graph, a hierarchical index, a fine-tuned retriever: each gets re-justified against the new model's baseline, and often torn down.

3. **What structure remains is portable across models.** Hybrid search, RRF, the tool-using agent loop itself — these aren't bets on the current model's weaknesses. They're primitives a stronger model uses better. That's the kind of structure worth keeping; the rest is the kind worth defending against with a loop.

4. **Cost rides the frontier downward too.** Per-token inference cost has fallen ~10× per 12–18 months at each capability tier. A fine-tuned retriever's per-token cost is already near the floor and its capability is frozen at training time. The crossover where retrieval beats the agent loop on total cost moves upward each model generation — quantified in *What This Costs* above.

The optimizations the loop did adopt on BRIGHT — per-domain prompts, per-doc sketches — are explicitly the removable kind. A prompt is text. A sketch is a column. When they stop earning their keep, you delete them. None of it is architectural commitment.

What's prediction vs finding here: the thin stack already being competitive on quality in 2026 is the finding. The thin stack winning on quality, maintenance, and cost over the next few model generations is the prediction. We're betting on it.

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

The loop validated simplicity on MuSiQue (every "improvement" we tried regressed) and adopted two cheap, removable optimization classes on BRIGHT (per-domain prompts, per-doc concept sketches) — same loop, opposite verdicts, same underlying logic.

The takeaway isn't that we beat a leaderboard. It's a posture for building RAG systems in a regime where the model is improving faster than your pipeline can. **RAG complexity is a bet against the model.** Most architectural additions in the field are compensating for a specific model's specific weaknesses, and they become overhead the moment the weakness goes away. A thin stack rides the model frontier; a complex pipeline has to be rebuilt to keep up.

The autoresearch loop's job, under this framing, isn't to discover sophistication. It's to be the antibody against accumulating it. Every change must earn its place against paired statistics; everything that doesn't gets reverted with a log entry. Stay thin by default.

If the bet is right, every pipeline built for yesterday's model becomes someone's maintenance burden. If it's wrong, the cost of being wrong is small: a Postgres table and a prompt.

The full code, experiment log, and per-domain methodology notes are available at [repo link].
