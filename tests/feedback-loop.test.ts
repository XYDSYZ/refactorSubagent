import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli/args.js";
import { composeRefactorFeedback } from "../src/runtime/feedback/repair.js";
import { runFeedbackLoop, routerInputOf, type FeedbackLoopConfig, type RepairRoundContext } from "../src/runtime/feedback/coordinator.js";
import type { StageFlowResult } from "../src/runtime/stage-flow.js";

/**
 * Feedback-loop tests: pure orchestration over scripted round results and a
 * captured repair context — no pipeline, no AI. The dialogue-continuation
 * stage itself was live-verified by the Phase 0 spike (spike-resume.ts).
 */

function fakeResult(options: {
  state: string;
  dialogueId?: string | null;
  branch?: string;
  commitSha?: string;
  failure?: { category: string; component: string; reason: string } | null;
  mismatches?: readonly { name: string; reason: string }[];
}): StageFlowResult {
  return {
    state: options.state,
    refactorSummary: "fake",
    refactorDialogueId: options.dialogueId ?? null,
    patch: options.branch !== undefined
      ? {
          branch: options.branch,
          base_sha: "base-000",
          commit_sha: options.commitSha ?? "commit-000",
          changed_files: ["src/x.c"],
          summary: "fake patch",
        }
      : null,
    declared: null,
    verification: {
      state: options.state,
      results: [],
      baselineBuild: null,
      candidateBuild: null,
      baseline: null,
      candidate: null,
      comparison: null,
      expectationComparison:
        options.state === "REJECTED"
          ? ({
              kind: "expectation-comparison-result",
              version: 1,
              overall: "inconsistent",
              declarations: (options.mismatches ?? []).map((mismatch) => ({
                name: mismatch.name,
                relation: "equal",
                matched: false,
                reason: mismatch.reason,
              })),
              errors: [],
              reason: "fake",
            } as never)
          : null,
    },
    provenance: { injected: [], verification_authoritative: true },
    failure: options.failure === undefined || options.failure === null
      ? null
      : {
          kind: "failure-report" as const,
          version: 1 as const,
          stage: "verify",
          category: options.failure.category,
          component: options.failure.component,
          retryable: true,
          reason: options.failure.reason,
          detail: {},
          at: "2026-01-01T00:00:00.000Z",
        },
    logDir: "D:\\fake\\log",
    store: {} as never,
  } as unknown as StageFlowResult;
}

interface Captured {
  rounds: string[];
  repairContexts: RepairRoundContext[];
  notifications: string[];
  pinnedCalls: number;
}

function makeConfig(
  script: readonly StageFlowResult[],
  captured: Captured,
  budget = 3,
): FeedbackLoopConfig {
  let call = 0;
  return {
    baseTask: "重构任务",
    budget,
    notify: (message) => captured.notifications.push(message),
    runInitial: async () => {
      captured.rounds.push("initial");
      const step = script[Math.min(call, script.length - 1)]!;
      call++;
      return step;
    },
    loadPinnedWorkflows: () => {
      captured.pinnedCalls += 1;
      return (async () => ({})) as never;
    },
    runRepairRound: async (round, context) => {
      captured.rounds.push(`repair-${String(round)}`);
      captured.repairContexts.push(context);
      const step = script[Math.min(call, script.length - 1)]!;
      call++;
      return step;
    },
  };
}

const MISMATCHES = [{ name: "csv[0].mean.stdout", reason: "baseline '0.000' vs candidate 'nan'" }];

describe("composeRefactorFeedback", () => {
  test("behavior mismatch lists the diffs and forbids drift", () => {
    const message = composeRefactorFeedback(
      "behavior-mismatch",
      { summary: "inconsistent", mismatches: MISMATCHES },
      { candidateBranch: "refactor/agent-x", round: 2 },
    );
    expect(message).toContain("csv[0].mean.stdout");
    expect(message).toContain("baseline '0.000' vs candidate 'nan'");
    expect(message).toContain("refactor/agent-x");
    expect(message).toContain("不要从原版重新完成整个任务");
    expect(message).toContain("与基线完全一致");
  });

  test("candidate-build and candidate-crash carry their evidence", () => {
    const build = composeRefactorFeedback(
      "candidate-build",
      { summary: "main.c:12: syntax error" },
      { candidateBranch: "b", round: 2 },
    );
    expect(build).toContain("编译失败");
    expect(build).toContain("main.c:12: syntax error");
    const crash = composeRefactorFeedback(
      "candidate-crash",
      { summary: "runner exited with assert failure (code 3)" },
      { candidateBranch: "b", round: 3 },
    );
    expect(crash).toContain("崩溃或卡死");
    expect(crash).toContain("assert failure");
  });
});

describe("routerInputOf", () => {
  test("derives the side from the attribution component", () => {
    const input = routerInputOf(
      fakeResult({
        state: "ABORTED",
        failure: { category: "build", component: "build-workflow:candidate", reason: "gcc failed" },
      }),
    );
    expect(input.side).toBe("candidate");
    expect(input.failure?.category).toBe("build");
  });
});

describe("runFeedbackLoop", () => {
  test("round 1 accepted: no repair, no budget spent", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(makeConfig([fakeResult({ state: "ACCEPTED" })], captured));
    expect(outcome.stoppedBecause).toBe("accepted");
    expect(captured.rounds).toEqual(["initial"]);
    expect(captured.pinnedCalls).toBe(0);
  });

  test("REJECTED round 1 continues the original dialogue and accepts in round 2", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([
        fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "refactor/agent-x", commitSha: "c1", mismatches: MISMATCHES }),
        fakeResult({ state: "ACCEPTED", dialogueId: "conv-1", branch: "refactor/agent-x", commitSha: "c2" }),
      ], captured),
    );
    expect(outcome.stoppedBecause).toBe("accepted");
    expect(captured.rounds).toEqual(["initial", "repair-2"]);
    // The repair round continued the SAME dialogue with the diff embedded.
    const context = captured.repairContexts[0]!;
    expect(context.dialogueId).toBe("conv-1");
    expect(context.candidateBranch).toBe("refactor/agent-x");
    expect(context.feedback).toContain("csv[0].mean.stdout");
    expect(context.pinnedWorkflows).not.toBeNull();
  });

  test("budget exhaustion keeps the last real result", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig(
        [
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "c1", mismatches: MISMATCHES }),
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "c2", mismatches: [{ name: "other", reason: "x" }] }),
        ],
        captured,
        1,
      ),
    );
    expect(outcome.stoppedBecause).toBe("budget-exhausted");
    expect(captured.rounds).toEqual(["initial", "repair-2"]);
  });

  test("identical artifact AND identical failure twice stop as no-progress", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig(
        [
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "same", mismatches: MISMATCHES }),
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "same", mismatches: MISMATCHES }),
        ],
        captured,
        3,
      ),
    );
    expect(outcome.stoppedBecause).toBe("no-progress");
    expect(captured.rounds).toEqual(["initial", "repair-2"]);
  });

  test("progress with a new commit keeps the loop going", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig(
        [
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "c1", mismatches: MISMATCHES }),
          fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", commitSha: "c2", mismatches: MISMATCHES }),
          fakeResult({ state: "ACCEPTED" }),
        ],
        captured,
        3,
      ),
    );
    expect(outcome.stoppedBecause).toBe("accepted");
    expect(captured.rounds).toEqual(["initial", "repair-2", "repair-3"]);
  });

  test("missing dialogue handle stops with a clear reason", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([fakeResult({ state: "REJECTED", dialogueId: null, branch: "b", mismatches: MISMATCHES })], captured),
    );
    expect(outcome.stoppedBecause).toBe("missing-dialogue");
    expect(captured.repairContexts).toHaveLength(0);
  });

  test("baseline build failure routes to the (unwired) build repair and stops honestly", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([
        fakeResult({
          state: "ABORTED",
          branch: "b",
          failure: { category: "build", component: "build-workflow:baseline", reason: "gcc exited 1" },
        }),
      ], captured),
    );
    expect(outcome.stoppedBecause).toBe("unwired-repair");
    expect(captured.repairContexts).toHaveLength(0);
    expect(captured.notifications.join("\n")).toContain("尚未接线");
  });

  test("environment failure routes to an immediate stop", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const outcome = await runFeedbackLoop(
      makeConfig([
        fakeResult({
          state: "ABORTED",
          failure: { category: "build", component: "build-workflow:baseline", reason: "gcc: command not found" },
        }),
      ], captured),
    );
    expect(outcome.stoppedBecause).toBe("routed-stop");
    expect(captured.repairContexts).toHaveLength(0);
  });

  test("pinned exam unavailable stops instead of re-authoring", async () => {
    const captured: Captured = { rounds: [], repairContexts: [], notifications: [], pinnedCalls: 0 };
    const config = makeConfig([fakeResult({ state: "REJECTED", dialogueId: "conv-1", branch: "b", mismatches: MISMATCHES })], captured);
    const outcome = await runFeedbackLoop({ ...config, loadPinnedWorkflows: () => null });
    expect(outcome.stoppedBecause).toBe("missing-patch");
    expect(captured.repairContexts).toHaveLength(0);
    expect(captured.notifications.join("\n")).toContain("考卷");
  });
});

describe("--auto-retry parsing (carried over from the auto-retry suite)", () => {
  test("defaults to 0 (disabled) and accepts an explicit 0", () => {
    const defaults = parseCliArgs(["run", ".", "--task", "t"]);
    expect(defaults.kind === "run" && defaults.autoRetry).toBe(0);
    const explicitZero = parseCliArgs(["run", ".", "--task", "t", "--auto-retry", "0"]);
    expect(explicitZero.kind === "run" && explicitZero.autoRetry).toBe(0);
    const three = parseCliArgs(["run", ".", "--task", "t", "--auto-retry", "3"]);
    expect(three.kind === "run" && three.autoRetry).toBe(3);
    expect(() => parseCliArgs(["run", ".", "--task", "t", "--auto-retry", "-1"])).toThrow(/non-negative/);
  });
});
