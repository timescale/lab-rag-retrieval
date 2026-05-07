// V2 of robotics sketch generation: sonnet + structured scaffolding +
// worked examples. Writes to meta.sketch_v2 (v1 stays in meta.sketch
// for trivial revert).
//
// Key changes vs v1:
// - Model: haiku → sonnet (better at canonical↔symptom bridging)
// - Schema: scaffolding fields (package, purpose, canonical_terms,
//   alternatives) force the model to think about each component
//   before assembling the final sketch.
// - 2 worked examples in the prompt.
// - Content window: 2000 → 4000 chars.
// - Re-tags ALL docs (sonnet may identify content as relevant where
//   haiku said empty), so the WHERE clause is "missing meta.sketch_v2"
//   not "empty sketch".

import postgres from "postgres";
import { createFileCache } from "./src/file-cache.ts";

const PROMPT_VERSION = "v2";
const cache = createFileCache<any>("data/sketch_cache_robotics_v2");

const CONCURRENCY = 20;
const BATCH_COMMIT_EVERY = 200;
const TIMEOUT_MS = 180_000; // 3 min — sonnet is slower

const PROMPT = (docId: string, content: string) => `You are extracting a CONCEPT FINGERPRINT from a robotics documentation chunk. The retrieval corpus is the BRIGHT robotics benchmark, which contains: ROS/ROS2 package docs, gazebo/ignition/gz-sim docs, robotics research papers (path planning, SLAM, control, perception), and supporting libraries. Treat ALL of these as robotics-relevant. The retrieval problem we are bridging: users describe problems using SYMPTOMS ("post-process rviz images", "alternative to ros2arduino", "real-time path planning algorithm with tree rewiring"), while doc chunks use CANONICAL names (package names, function names, ALGORITHM names like "RT-RRT*", "FastSLAM"). Your sketch must contain BOTH vocabularies so a search from either side matches.

Fill these fields:
- package: the primary package/library/module/ALGORITHM name. For research-paper chunks, the algorithm or method name (RT-RRT*, ORB-SLAM, ICP, MPC, Kalman filter). For tutorial chunks, the package or topic. Use the doc ID directory as the strongest hint.
- purpose: 1-2 sentences describing what stuck-developer problem leads here, in user-symptom phrasing (think "what would I google when I'm stuck?"). For papers, what robotics problem does the technique solve.
- canonical_terms: comma-separated function/class/parameter/CLI/topic/ALGORITHM names the chunk actually uses (what a researcher or maintainer would search for).
- alternatives: comma-separated related/alternative packages OR alternative algorithms a user might also search for, or empty if none.
- sketch: 80-120 word lowercase paragraph combining all four. No markdown. Both canonical names AND user-symptom phrases must appear naturally.

ONLY return empty fields if the chunk is genuinely empty, just navigation/footer/license-header text, a release-notes changelog stub, or completely unrelated to robotics (e.g. an unrelated wikipedia page). When in doubt, write a sketch — research-paper chunks, algorithm descriptions, conference-paper excerpts, and how-to tutorials all qualify as robotics-relevant.

WORKED EXAMPLES.

Example 1 — image_proc rectify (ROS package):
{
  "package": "image_proc",
  "purpose": "rectifying camera images and fixing lens distortion before downstream perception. users hit this when they see warped/distorted images in rviz or want clean undistorted feeds for object detection.",
  "canonical_terms": "rectify, image_rect, image_raw, camera_info, ApproximateTimeSynchronizer, image_pipeline",
  "alternatives": "cv_bridge for opencv interop, image_view for visualization, image_transport for compressed transport",
  "sketch": "image_proc package providing camera image rectification — the standard way to fix lens distortion in rviz/visualization or post-process raw camera feeds for downstream perception. canonical interface: subscribe image_raw + camera_info, publish image_rect via the rectify node. uses image_pipeline plumbing and ApproximateTimeSynchronizer for synchronized callbacks. user symptoms: distorted camera images, undistorting images before yolo/detection, weird warping in rviz. alternative to manual cv_bridge + opencv pipelines, related to image_view for display and image_transport for compressed feeds."
}

Example 2 — ros2_control TopicBasedSystem (tutorial / API doc):
{
  "package": "ros2_control",
  "purpose": "implementing a hardware interface that talks to existing ros topics rather than a real device — for testing controllers without hardware, or bridging ros2_control to legacy topic-based devices.",
  "canonical_terms": "TopicBasedSystem, hardware_interface::SystemInterface, on_init, on_activate, lifecycle_node, ros2_control_demos, command_interface, state_interface",
  "alternatives": "GazeboSimSystem for simulation, MockHardwareSystem for purely-internal testing, ros2_control_demos DiffBot/RRBot/CarlikeBot examples",
  "sketch": "ros2_control TopicBasedSystem hardware interface for users wanting to test controllers without real hardware or bridge ros2_control to topic-based legacy devices. subclasses hardware_interface::SystemInterface with on_init/on_activate/lifecycle_node lifecycle and standard command_interface/state_interface plumbing. user symptoms: testing a controller without hardware, simulating a robot via topics, alternative to ros2arduino or micro_ros for non-serial bridging. canonical: TopicBasedSystem, ros2_control_demos. alternative to GazeboSimSystem (simulation) or MockHardwareSystem (internal testing); see DiffBot/RRBot/CarlikeBot example configs."
}

Example 3 — RT-RRT* path planning paper (research):
{
  "package": "RT-RRT*",
  "purpose": "real-time path planning in dynamic environments where the robot must continuously replan around moving obstacles toward shifting goals. users hit this when classical RRT*/RRT-Connect freeze on long planning queries or can't react to changing goals.",
  "canonical_terms": "RT-RRT*, real-time RRT, tree rewiring, retained tree, kd-tree neighbor search, ellipsoid sampling, CL-RRT, asymptotic optimality, c-pbp",
  "alternatives": "RRT-Connect, BIT*, informed RRT*, CL-RRT, anytime RRT, lazy RRT, MoveIt OMPL planners",
  "sketch": "RT-RRT* real-time path planning algorithm that retains and rewires the search tree across replanning queries to react to moving obstacles and shifting goals. user symptoms: rrt* too slow for online use, robot needs to replan continuously, dynamic-obstacle avoidance, real-time motion planning in changing environments. canonical methods: tree rewiring, ellipsoid-focused sampling, kd-tree neighbor search, retained tree across queries, separate path planning from motion planning via c-pbp. compared in the paper against CL-RRT (the prior real-time RRT state-of-the-art). alternative real-time/optimal planners: RRT-Connect, BIT*, informed RRT*, anytime RRT, MoveIt OMPL plugins."
}

Doc ID:
${docId}

Chunk:
"""
${content.slice(0, 4000)}
"""`;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    package: { type: "string" },
    purpose: { type: "string" },
    canonical_terms: { type: "string" },
    alternatives: { type: "string" },
    sketch: { type: "string" },
  },
  required: ["package", "purpose", "canonical_terms", "alternatives", "sketch"],
});

interface Sketched {
  package: string;
  purpose: string;
  canonical_terms: string;
  alternatives: string;
  sketch: string;
}

async function generate(docId: string, content: string): Promise<Sketched> {
  const proc = Bun.spawn([
    "claude", "-p", PROMPT(docId, content),
    "--setting-sources", "project",
    "--model", "sonnet",
    "--output-format", "json",
    "--json-schema", SCHEMA,
  ], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  try {
    const evts = JSON.parse(stdout);
    for (const evt of Array.isArray(evts) ? evts : [evts]) {
      if (evt.type === "result" && evt.structured_output) {
        const out = evt.structured_output as any;
        return {
          package: typeof out.package === "string" ? out.package : "",
          purpose: typeof out.purpose === "string" ? out.purpose : "",
          canonical_terms: typeof out.canonical_terms === "string" ? out.canonical_terms : "",
          alternatives: typeof out.alternatives === "string" ? out.alternatives : "",
          sketch: typeof out.sketch === "string" ? out.sketch : "",
        };
      }
    }
    throw new Error("no structured_output");
  } catch (e: any) {
    throw new Error(e.message?.slice(0, 80) || "parse error");
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, max_lifetime: 0, idle_timeout: 30, max: 5 });

  const countRow = await sql.unsafe(
    `SELECT count(*)::int as c FROM bright_robotics
     WHERE NOT (coalesce(meta, '{}'::jsonb) ? 'sketch_v2')`,
  );
  const remaining = (countRow[0] as any).c;
  console.log(`rows to process (missing meta.sketch_v2): ${remaining}`);
  if (remaining === 0) { await sql.end(); return; }

  const t0 = Date.now();
  let done = 0, errs = 0, lastLog = 0;
  let pendingUpdates: Array<{ id: string; data: Sketched }> = [];

  async function commitBatch() {
    if (pendingUpdates.length === 0) return;
    await Promise.all(pendingUpdates.map(({ id, data }) =>
      sql.unsafe(
        `UPDATE bright_robotics
         SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('sketch_v2', $1::jsonb)
         WHERE id = $2`,
        [JSON.stringify(data), id],
      ),
    ));
    pendingUpdates = [];
  }

  const PAGE = 2000;
  async function* rowStream() {
    while (true) {
      const rows = await sql.unsafe(`
        SELECT id, content FROM bright_robotics
        WHERE NOT (coalesce(meta, '{}'::jsonb) ? 'sketch_v2')
        ORDER BY id LIMIT $1
      `, [PAGE]) as any[];
      if (rows.length === 0) return;
      for (const r of rows) yield r;
    }
  }

  const iter = rowStream()[Symbol.asyncIterator]();
  async function worker() {
    while (true) {
      const { value: r, done: d } = await iter.next();
      if (d) return;
      const key = cache.key(PROMPT_VERSION, r.id, r.content);
      let data = cache.get(key) as Sketched | null;
      if (data === null) {
        try {
          data = await generate(r.id, r.content);
          cache.set(key, data);
        } catch (e: any) {
          errs++;
          data = { package: "", purpose: "", canonical_terms: "", alternatives: "", sketch: "" };
        }
      }
      pendingUpdates.push({ id: r.id, data });
      if (pendingUpdates.length >= BATCH_COMMIT_EVERY) await commitBatch();
      done++;
      if (done - lastLog >= 200) {
        lastLog = done;
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = (remaining - done) / rate;
        process.stdout.write(`  sketched ${done}/${remaining} (${rate.toFixed(2)}/s, ETA ${(eta/60).toFixed(1)}min, errs ${errs})\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await commitBatch();

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`done: ${done} sketched in ${(elapsed/60).toFixed(1)}min, ${errs} errors`);
  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch((e) => { console.error("failed:", e); process.exit(1); });
