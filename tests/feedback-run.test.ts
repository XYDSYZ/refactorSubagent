import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedProcess } from "../shared/owned-process.js";
import type { EffectivePlan } from "../src/runtime/feedback/effective-plan.js";
import type { FeedbackState } from "../src/runtime/feedback/types.js";
import type { WorkflowsCheckpointView } from "../src/runtime/stage-resume.js";
import type { ExpectationBaseline } from "../src/artifacts/index.js";

interface Replay {
  stoppedBecause: string;
  calls: { role: string; resume: string | null }[];
  state: FeedbackState;
  plan: EffectivePlan;
  owner: string;
  snapshots: { session: string; state: string; workflows: WorkflowsCheckpointView; contentHash: string; baseline: ExpectationBaseline | null; measuredBaseline: boolean }[];
}

async function replay(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "rfr-feedback-replay-"));
  const process = spawnOwnedProcess({
    program: globalThis.process.execPath,
    args: [fileURLToPath(new URL("./helpers/feedback-replay.ts", import.meta.url)), scenario, root],
    cwd: fileURLToPath(new URL("..", import.meta.url)), cooperativeShutdown: true,
    env: { ...globalThis.process.env, RFR_LOG_LEVEL: "error" },
  });
  let stdout = "";
  let stderr = "";
  process.child.stdout?.setEncoding("utf8").on("data", (data) => { stdout += data; });
  process.child.stderr?.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => { void process.stop(); }, 120_000);
  try {
    const exit = await process.exited;
    const expected = scenario.startsWith("cli-budget") ? 1 : 0;
    if (exit.error !== null || exit.code !== expected) throw new Error(`replay ${scenario} exited ${String(exit.code)}: ${String(exit.error)}\n${stderr}\n${stdout}`);
    return { report: JSON.parse(readFileSync(join(root, "replay.json"), "utf8")) as Replay, stdout, stderr };
  } finally {
    clearTimeout(timer);
    await process.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("feedback through the real pipeline (offline SDK replay)", () => {
  test("repairing build A then build B retains both delivered repairs", async () => {
    const { report } = await replay("build-pair");
    expect(report.stoppedBecause).toBe("accepted");
    expect(report.snapshots.map((round) => round.state)).toEqual(["ABORTED", "ABORTED", "ACCEPTED"]);
    const ids = report.snapshots.map((round) => round.workflows.builds.map((build) => build.id));
    expect(ids[1]![0]).not.toBe(ids[0]![0]);
    expect(ids[2]![0]).toBe(ids[1]![0]);
    expect(ids[2]![1]).not.toBe(ids[1]![1]);
    expect(report.state.budgetUsed).toBe(2);
  }, 120_000);

  test.each(["build-refactor", "test-refactor"])("%s keeps the new plan when continuing the code conversation", async (scenario) => {
    const { report } = await replay(scenario);
    expect(report.stoppedBecause).toBe("accepted");
    expect(report.snapshots.map((round) => round.state)).toEqual(["ABORTED", "REJECTED", "ACCEPTED"]);
    expect(report.snapshots[2]!.contentHash).toBe(report.snapshots[1]!.contentHash);
    expect(report.snapshots[2]!.measuredBaseline).toBe(false);
    expect(report.snapshots[1]!.measuredBaseline).toBe(true);
    expect(report.snapshots[2]!.baseline).toEqual(report.snapshots[1]!.baseline);
    expect(report.calls.at(-1)).toEqual({ role: "refactor", resume: "refactor-dialogue" });
    if (scenario === "test-refactor") {
      expect(report.calls).toContainEqual({ role: "writer", resume: "writer-dialogue" });
      expect(report.snapshots[2]!.baseline?.expectations[0]?.value).toBe("new:original");
    }
  }, 120_000);

  test("registering the same broken recipe with a new session id stops as no progress", async () => {
    const { report } = await replay("no-progress");
    expect(report.stoppedBecause).toBe("no-progress");
    expect(report.state.budgetUsed).toBe(1);
    expect(report.snapshots[0]!.workflows.builds[0]!.id).not.toBe(report.snapshots[1]!.workflows.builds[0]!.id);
    expect(report.state.rounds[0]!.artifactHash).toBe(report.state.rounds[1]!.artifactHash);
    expect(report.state.rounds[0]!.failureSignature).toBe(report.state.rounds[1]!.failureSignature);
  }, 120_000);

  test.each(["cli-budget0", "cli-budget1"])("%s resumes through the CLI without resetting the spent budget", async (scenario) => {
    const { report, stdout } = await replay(scenario);
    const result = JSON.parse(stdout);
    expect(result.state).toBe("ABORTED");
    expect(result.auto_retry.stoppedBecause).toBe("budget-exhausted");
    expect(report.state.budgetUsed).toBe(1);
    expect(report.calls.filter((call) => call.role === "build")).toHaveLength(1);
    expect(report.owner).toBe("first");
    expect(report.state.rounds.at(-1)?.budgeted).toBe(false);
    expect(report.state.rounds.at(-1)?.round).toBe(3);
  }, 120_000);

  test("a writer recreated during resume can subsequently continue from the shared transcript store", async () => {
    const { report, stdout } = await replay("cli-reauthor");
    expect(JSON.parse(stdout).state).toBe("ACCEPTED");
    expect(report.calls.filter((call) => call.role === "writer")).toEqual([
      { role: "writer", resume: null },
      { role: "writer", resume: null },
      { role: "writer", resume: "writer-dialogue2" },
    ]);
    expect(report.state.budgetUsed).toBe(2);
    expect(report.owner).toBe("first");
  }, 120_000);

  test("CLI resume can repair a run that initially had feedback disabled, using its old conversations", async () => {
    const { report, stdout } = await replay("cli-resume");
    const result = JSON.parse(stdout);
    expect(result.state).toBe("ACCEPTED");
    expect(result.auto_retry.rounds).toBe(3);
    expect(report.owner).toBe("first");
    expect(report.state.budgetUsed).toBe(2);
    expect(report.calls.filter((call) => call.role === "writer")).toHaveLength(1);
    expect(report.calls.at(-1)).toEqual({ role: "refactor", resume: "refactor-dialogue" });
  }, 120_000);
});
