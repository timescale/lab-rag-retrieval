// Sample test: run v2 (sonnet + better prompt) on a handful of docs
// and print v1 vs v2 side-by-side to verify quality improves before
// committing to the full ~32k re-tag.
//
// Picks docs that came up as gold in past evals (so we sample where it
// actually matters for retrieval), plus some random docs to see the
// general distribution.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { createFileCache } from "./src/file-cache.ts";

const cache_v2 = createFileCache<any>("data/sketch_cache_robotics_v2");

const PROMPT_VERSION = "v2";
const TIMEOUT_MS = 180_000;

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

async function generate(docId: string, content: string): Promise<any> {
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
  const evts = JSON.parse(stdout);
  for (const evt of Array.isArray(evts) ? evts : [evts]) {
    if (evt.type === "result" && evt.structured_output) {
      return evt.structured_output;
    }
  }
  throw new Error("no structured_output");
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, max_lifetime: 0, idle_timeout: 30 });

  // Pull gold IDs from the BRIGHT robotics examples — these are the docs
  // whose sketch quality actually affects retrieval recall.
  const lines = readFileSync("data/bright/robotics/examples.jsonl", "utf-8").trim().split("\n");
  const goldIds = new Set<string>();
  for (const l of lines) {
    const r = JSON.parse(l);
    for (const g of r.gold_ids ?? []) goldIds.add(g);
  }
  const goldArr = Array.from(goldIds);
  console.log(`total unique gold IDs: ${goldArr.length}`);

  // Sample 8 gold docs (where v1 has a non-empty sketch — comparable case).
  const sample = await sql.unsafe(`
    SELECT id, content, meta->>'sketch' as v1_sketch
    FROM bright_robotics
    WHERE id = ANY($1::text[])
      AND coalesce(meta->>'sketch','') <> ''
    ORDER BY random()
    LIMIT 8
  `, [goldArr]) as any[];

  console.log(`sampled ${sample.length} gold docs with non-empty v1 sketches`);
  console.log();

  for (const r of sample) {
    console.log(`\n=== ${r.id} (clen=${r.content.length})`);
    console.log(`\nv1 (haiku):`);
    console.log(r.v1_sketch);

    let v2: any;
    try {
      const key = cache_v2.key(PROMPT_VERSION, r.id, r.content);
      const cached = cache_v2.get(key);
      if (cached) {
        v2 = cached;
        console.log(`\nv2 (sonnet) [cached]:`);
      } else {
        v2 = await generate(r.id, r.content);
        cache_v2.set(key, v2);
        console.log(`\nv2 (sonnet) [fresh]:`);
      }
      console.log(`  package: ${v2.package}`);
      console.log(`  purpose: ${v2.purpose}`);
      console.log(`  canonical_terms: ${v2.canonical_terms}`);
      console.log(`  alternatives: ${v2.alternatives}`);
      console.log(`  sketch: ${v2.sketch}`);
    } catch (e: any) {
      console.log(`\nv2 ERR: ${e.message}`);
    }
  }

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
