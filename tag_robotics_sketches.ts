// Generate per-doc concept sketches for the robotics corpus, bridging
// user-symptom vocabulary ↔ canonical-doc vocabulary. See the analysis
// in experimental_log_bright.md for why this is a corpus-side fix
// (raw-query retrieval recall on robotics caps at ~0.335 @100; sketches
// inject user-vocabulary into doc indexes so symptom-language searches
// match docs that use canonical package/function names).
//
// Stored in meta.sketch. Resumable via cache + WHERE-clause skip.

import postgres from "postgres";
import { createFileCache } from "./src/file-cache.ts";

const PROMPT_VERSION = "v1";
const cache = createFileCache<any>("data/sketch_cache_robotics");

const CONCURRENCY = 20;
const BATCH_COMMIT_EVERY = 200;
const TIMEOUT_MS = 90_000;

const PROMPT = (docId: string, content: string) => `You are extracting a CONCEPT FINGERPRINT from a ROS/robotics documentation chunk. The retrieval problem we are bridging: users describe problems using SYMPTOMS ("post-process rviz images", "alternative to ros2arduino", "subscriber in hardware interface"), while doc chunks use CANONICAL package/function names ("image_proc rectify", "ros2_serial_interface", "TopicBasedSystem"). Your sketch must contain BOTH vocabularies so a search from either side matches.

Output strict JSON:
{ "sketch": "<3-4 sentences, ~80-120 words>" }

The sketch MUST include:
1) PACKAGE / LIBRARY / EXAMPLE name. The doc ID is the strongest hint — its directory is usually a package or topic name. Spell the package out fully (image_proc, image_pipeline, ros2_serial_interface, ros2_control, ros2_control_demos TopicBasedSystem, MoveIt2 moveit_configs_utils, NAV2, robot_localization, octomap_server, ouster_ros, gazebo_ros2_control, plotjuggler, tf2, rclcpp, behavior_trees, microxrcedds_agent, etc.).
2) FUNCTIONAL PURPOSE in user-symptom phrasing: what stuck-developer problem leads a user here ("rectifying camera images in ROS, fixing distortion in rviz", "connecting Arduino over serial to ROS2", "adding a subscriber inside a hardware interface", "comparing odometry trajectories", "occupancy grid from depth sensor").
3) CANONICAL terms the chunk actually uses (function/class/parameter/CLI names). These are what a maintainer would search for: rectify, camera_info, MoveItConfigsBuilder, OctomapServerCfg, on_init, hardware_interface::SystemInterface, lifecycle_node.
4) ALTERNATIVES, if applicable. If this package is one of several that solve the same problem, name the alternatives so a user searching by the alternative also matches. ("alternative to ros2arduino / micro_ros_arduino", "alternative to DiffBot example, also see RRBot/CarlikeBot", "alternative to cv_bridge OpenCV pipeline").

Rules:
- 80-120 words.
- Lowercase. No markdown.
- Both ways: canonical terms (for expert/precise searches) AND user-symptom phrases (for natural-language searches).
- If the chunk has no robotics relevance, is empty, or is just navigation/footer text, output {"sketch": ""}.

Doc ID:
${docId}

Chunk:
"""
${content.slice(0, 2000)}
"""

JSON:`;

const SCHEMA = JSON.stringify({
  type: "object",
  properties: { sketch: { type: "string" } },
  required: ["sketch"],
});

async function generate(docId: string, content: string): Promise<string> {
  const proc = Bun.spawn([
    "claude", "-p", PROMPT(docId, content),
    "--setting-sources", "project",
    "--model", "haiku",
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
        return typeof out.sketch === "string" ? out.sketch : "";
      }
    }
    throw new Error("no structured_output");
  } catch (e: any) {
    throw new Error(e.message?.slice(0, 80) || "parse error");
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {}, max_lifetime: 0, idle_timeout: 30, max: 5 });

  // Process docs missing a sketch OR docs whose sketch is empty (likely
  // errored during the prior tag run — they didn't cache so a retry will
  // re-issue the LLM call). Intentionally-empty docs ARE cached (as "")
  // so a cache.get hit will return "" and skip the API.
  const countRow = await sql.unsafe(
    `SELECT count(*)::int as c FROM bright_robotics
     WHERE NOT (coalesce(meta, '{}'::jsonb) ? 'sketch')
        OR coalesce(meta->>'sketch','') = ''`,
  );
  const remaining = (countRow[0] as any).c;
  console.log(`rows to process: ${remaining}`);
  if (remaining === 0) { await sql.end(); return; }

  const t0 = Date.now();
  let done = 0, errs = 0, lastLog = 0;
  let pendingUpdates: Array<{ id: string; sketch: string }> = [];

  async function commitBatch() {
    if (pendingUpdates.length === 0) return;
    await Promise.all(pendingUpdates.map(({ id, sketch }) =>
      sql.unsafe(
        `UPDATE bright_robotics
         SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('sketch', $1::text)
         WHERE id = $2`,
        [sketch, id],
      ),
    ));
    pendingUpdates = [];
  }

  const PAGE = 2000;
  async function* rowStream() {
    while (true) {
      const rows = await sql.unsafe(`
        SELECT id, content FROM bright_robotics
        WHERE NOT (coalesce(meta, '{}'::jsonb) ? 'sketch')
           OR coalesce(meta->>'sketch','') = ''
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
      let sketch = cache.get(key);
      if (sketch === null) {
        try {
          sketch = await generate(r.id, r.content);
          cache.set(key, sketch);
        } catch (e: any) {
          errs++;
          sketch = "";
        }
      }
      pendingUpdates.push({ id: r.id, sketch });
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
