// Scoring wrapper — calls MuSiQue's SQuAD-style scoring via Python subprocess.
// Takes max F1/EM over answer + answer_aliases.

import { resolve } from "node:path";

const PYTHON = resolve(import.meta.dir, "../.venv/bin/python3");
const SCORER = resolve(import.meta.dir, "scorer.py");

interface ScoreInput {
  prediction: string;
  answer: string;
  answer_aliases: string[];
}

interface ScoreOutput {
  f1: number;
  em: number;
}

export async function scoreBatch(
  items: ScoreInput[],
): Promise<ScoreOutput[]> {
  const proc = Bun.spawn([PYTHON, SCORER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(JSON.stringify(items));
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Scorer failed (exit ${exitCode}): ${stderr}`);
  }

  return JSON.parse(stdout) as ScoreOutput[];
}
