// Find and re-tag the docs whose sketches are empty AND have no cache file
// (= errored consistently). Tries the LLM with retries; if all retries
// still fail, prints a debug dump to inspect what's breaking.

import postgres from "postgres";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createFileCache } from "./src/file-cache.ts";

const cache = createFileCache<string>("data/sketch_cache_robotics");
const PROMPT_VERSION = "v1";

const PROMPT = (docId: string, content: string) => `You are extracting a CONCEPT FINGERPRINT from a ROS/robotics documentation chunk. The retrieval problem we are bridging: users describe problems using SYMPTOMS ("post-process rviz images", "alternative to ros2arduino", "subscriber in hardware interface"), while doc chunks use CANONICAL package/function names ("image_proc rectify", "ros2_serial_interface", "TopicBasedSystem"). Your sketch must contain BOTH vocabularies so a search from either side matches.

Output strict JSON:
{ "sketch": "<3-4 sentences, ~80-120 words>" }

The sketch MUST include:
1) PACKAGE / LIBRARY / EXAMPLE name. The doc ID is the strongest hint — its directory is usually a package or topic name. Spell the package out fully (image_proc, image_pipeline, ros2_serial_interface, ros2_control, ros2_control_demos TopicBasedSystem, MoveIt2 moveit_configs_utils, NAV2, robot_localization, octomap_server, ouster_ros, gazebo_ros2_control, plotjuggler, tf2, rclcpp, behavior_trees, microxrcedds_agent, etc.).
2) FUNCTIONAL PURPOSE in user-symptom phrasing.
3) CANONICAL terms the chunk actually uses.
4) ALTERNATIVES, if applicable.

Rules:
- 80-120 words.
- Lowercase. No markdown.
- Both ways: canonical terms AND user-symptom phrases.
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

async function tryGenerate(docId: string, content: string, attempt: number): Promise<{ ok: boolean; sketch?: string; rawStdout?: string; err?: string }> {
  const proc = Bun.spawn([
    "claude", "-p", PROMPT(docId, content),
    "--setting-sources", "project",
    "--model", "haiku",
    "--output-format", "json",
    "--json-schema", SCHEMA,
  ], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 120_000);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  clearTimeout(timer);
  try {
    const evts = JSON.parse(stdout);
    for (const evt of Array.isArray(evts) ? evts : [evts]) {
      if (evt.type === "result" && evt.structured_output) {
        const out = evt.structured_output as any;
        const sketch = typeof out.sketch === "string" ? out.sketch : "";
        return { ok: true, sketch };
      }
    }
    return { ok: false, rawStdout: stdout.slice(0, 800), err: `attempt ${attempt}: no structured_output; stderr=${stderr.slice(0, 200)}` };
  } catch (e: any) {
    return { ok: false, rawStdout: stdout.slice(0, 800), err: `attempt ${attempt}: ${e.message?.slice(0, 200)}` };
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, {
    onnotice: () => {}, max_lifetime: 0, idle_timeout: 30,
  });

  // Find empty-sketch docs whose cache file does NOT exist.
  // Pull all empty-sketch ids and content, filter in JS.
  const rows = await sql.unsafe(`
    SELECT id, content FROM bright_robotics
    WHERE meta->>'sketch' = '' OR NOT (meta ? 'sketch')
  `) as any[];
  console.log(`empty-or-missing-sketch docs in DB: ${rows.length}`);

  function key(id: string, content: string) {
    const h = createHash("sha256");
    for (const p of [PROMPT_VERSION, id, content]) { h.update(p); h.update("\0"); }
    return h.digest("hex");
  }

  const errored = rows.filter(r => {
    const k = key(r.id, r.content);
    return !existsSync(`data/sketch_cache_robotics/${k}.json`);
  });
  console.log(`errored (no cache file): ${errored.length}`);

  if (errored.length === 0) { await sql.end(); return; }

  console.log(`\nattempting up to 3 LLM retries each...\n`);
  const stillErrored: any[] = [];
  let recovered = 0;
  let recoveredNonempty = 0;

  for (const r of errored) {
    let result: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await tryGenerate(r.id, r.content, attempt);
      if (result.ok) break;
      console.error(`  ${r.id} attempt ${attempt} failed: ${result.err}`);
    }
    if (result?.ok) {
      cache.set(key(r.id, r.content), result.sketch ?? "");
      await sql.unsafe(
        `UPDATE bright_robotics
         SET meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('sketch', $1::text)
         WHERE id = $2`,
        [result.sketch ?? "", r.id],
      );
      recovered++;
      if ((result.sketch ?? "").length > 0) recoveredNonempty++;
      const status = (result.sketch ?? "").length > 0 ? "NONEMPTY" : "empty";
      console.log(`  ✓ ${r.id} → ${status} (${(result.sketch ?? "").length} chars)`);
    } else {
      stillErrored.push({ id: r.id, contentLen: r.content.length, err: result?.err, rawStdout: result?.rawStdout });
      console.log(`  ✗ ${r.id} still errors after 3 attempts`);
    }
  }

  console.log(`\nrecovered: ${recovered} (${recoveredNonempty} nonempty)`);
  console.log(`still errored: ${stillErrored.length}`);
  if (stillErrored.length > 0) {
    console.log(`\nDebug dump for still-errored:`);
    for (const e of stillErrored) {
      console.log(`\n=== ${e.id} (clen=${e.contentLen})`);
      console.log(`  err: ${e.err}`);
      console.log(`  raw stdout (first 800 chars): ${e.rawStdout}`);
    }
  }

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
