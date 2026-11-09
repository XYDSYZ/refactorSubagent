import { describe, expect, test } from "bun:test";
import {
  composeGiveUpReport,
  composeRetryTask,
  extractMismatches,
  runWithAutoRetry,
  signatureOf,
  type AutoRetryConfig,
  type BehaviorMismatch,
} from "../src/runtime/auto-retry.js";
import type { StageFlowResult } from "../src/runtime/stage-flow.js";

/**
 * Bounded auto-retry: pure orchestration over a scripted `runRound` callback —
 * no real pipeline, no AI. We verify the guardrails: lesson composition,
 * round caps, identical-signature loop detection, and the ABORTED bypass.
 */

function fakeResult(options: {
  state: string;
  mismatches?: readonly BehaviorMismatch[];
  sessionId?: string;
}): StageFlowResult {
  return {
    state: options.state,
    refactorSummary: "fake summary",
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
    failure: null,
    logDir: "D:\\fake\\log",
    store: {} as never,
  } as unknown as StageFlowResult;
}

function makeConfig(
  script: readonly { state: string; mismatches?: readonly BehaviorMismatch[] }[],
  captured: { tasks: string[]; notifications: string[] },
  maxRetries = 2,
): AutoRetryConfig {
  let call = 0;
  return {
    baseTask: "重构 statkit 的 CSV 解析实现",
    maxRetries,
    runRound: async (round, task, sessionId) => {
      captured.tasks.push(`r${round}:${sessionId}:${task}`);
      const step = script[Math.min(call, script.length - 1)]!;
      call++;
      return fakeResult({ ...step, sessionId });
    },
    makeSessionId: (round) => (round === 1 ? "run-base" : `run-base-r${round}`),
    notify: (message) => captured.notifications.push(message),
  };
}

const MISMATCH_A: BehaviorMismatch[] = [
  { name: "csv[0].mean.stdout", reason: "baseline '0.000' vs candidate 'nan'" },
];
const MISMATCH_B: BehaviorMismatch[] = [
  { name: "cli.usage.exit", reason: "baseline '2' vs candidate '0'" },
];

describe("extractMismatches / signatureOf", () => {
  test("collects only failed expectations; signature is order-independent", () => {
    const accepted = fakeResult({ state: "ACCEPTED" });
    expect(extractMismatches(accepted)).toEqual([]);
    expect(signatureOf([])).toBeNull();

    const rejected = fakeResult({ state: "REJECTED", mismatches: [MISMATCH_B[0]!, MISMATCH_A[0]!] });
    const mismatches = extractMismatches(rejected);
    expect(mismatches).toHaveLength(2);
    expect(signatureOf(mismatches)).toBe(signatureOf([MISMATCH_A[0]!, MISMATCH_B[0]!]));
  });
});

describe("composeRetryTask", () => {
  test("keeps the original task and appends the black-box lesson", () => {
    const task = composeRetryTask("原任务文本", 2, MISMATCH_A);
    expect(task.startsWith("原任务文本")).toBe(true);
    expect(task).toContain("第 2 轮重试");
    expect(task).toContain("csv[0].mean.stdout");
    expect(task).toContain("baseline '0.000' vs candidate 'nan'");
    // The lesson must NOT describe the verifier internals.
    expect(task).not.toContain("expectationComparison");
    expect(task).not.toContain("declarations");
  });
});

describe("runWithAutoRetry", () => {
  test("an ACCEPTED first round never retries", async () => {
    const captured: { tasks: string[]; notifications: string[] } = { tasks: [], notifications: [] };
    const outcome = await runWithAutoRetry(makeConfig([{ state: "ACCEPTED" }], captured));
    expect(outcome.stoppedBecause).toBe("accepted");
    expect(outcome.rounds).toHaveLength(1);
    expect(captured.tasks).toHaveLength(1);
    expect(captured.tasks[0]!.startsWith("r1:run-base:重构 statkit")).toBe(true);
  });

  test("a REJECTED round feeds its diffs to the next round; acceptance stops the loop", async () => {
    const captured: { tasks: string[]; notifications: string[] } = { tasks: [], notifications: [] };
    const outcome = await runWithAutoRetry(
      makeConfig([{ state: "REJECTED", mismatches: MISMATCH_A }, { state: "ACCEPTED" }], captured),
    );
    expect(outcome.stoppedBecause).toBe("accepted");
    expect(outcome.rounds).toHaveLength(2);
    // Round 2 ran under a fresh session id with the lesson embedded.
    expect(captured.tasks[1]!.startsWith("r2:run-base-r2:")).toBe(true);
    expect(captured.tasks[1]!).toContain("csv[0].mean.stdout");
    expect(captured.notifications.join("\n")).toContain("教训起作用了");
  });

  test("two identical signatures in a row stop the loop with a plain-language report", async () => {
    const captured: { tasks: string[]; notifications: string[] } = { tasks: [], notifications: [] };
    const outcome = await runWithAutoRetry(
      makeConfig(
        [
          { state: "REJECTED", mismatches: MISMATCH_A },
          { state: "REJECTED", mismatches: [...MISMATCH_A].reverse() },
        ],
        captured,
      ),
    );
    expect(outcome.stoppedBecause).toBe("loop-detected");
    expect(captured.tasks).toHaveLength(2); // no third round
    const report = captured.notifications.at(-1)!;
    // Plain language: first person, subject next to verb, actionable advice.
    expect(report).toContain("我一共运行了 2 轮");
    expect(report).toContain("陷入循环");
    expect(report).toContain("expectation-comparison-result.json");
    expect(report).toContain("修改任务描述");
  });

  test("exhausting the allowed retries stops with a distinct report", async () => {
    const captured: { tasks: string[]; notifications: string[] } = { tasks: [], notifications: [] };
    const outcome = await runWithAutoRetry(
      makeConfig(
        [
          { state: "REJECTED", mismatches: MISMATCH_A },
          { state: "REJECTED", mismatches: MISMATCH_B },
        ],
        captured,
        1,
      ),
    );
    expect(outcome.stoppedBecause).toBe("rounds-exhausted");
    expect(outcome.rounds).toHaveLength(2);
    const report = captured.notifications.at(-1)!;
    expect(report).toContain("用完您允许的重试次数（1 次）");
  });

  test("an ABORTED round stops immediately and points the user at --resume", async () => {
    const captured: { tasks: string[]; notifications: string[] } = { tasks: [], notifications: [] };
    const config = makeConfig([{ state: "ABORTED" }], captured);
    const outcome = await runWithAutoRetry(config);
    expect(outcome.stoppedBecause).toBe("aborted");
    expect(captured.tasks).toHaveLength(1); // no retry after an abort
    expect(captured.notifications.join("\n")).toContain("--resume run-base");
  });
});

describe("composeGiveUpReport", () => {
  test("reports each round and the stop reason without dead-subject phrasing", () => {
    const report = composeGiveUpReport(
      [
        { round: 1, sessionId: "s1", state: "REJECTED", mismatches: MISMATCH_A, signature: "a", logDir: "L1" },
        { round: 2, sessionId: "s2", state: "REJECTED", mismatches: MISMATCH_A, signature: "a", logDir: "L2" },
      ],
      "loop-detected",
      2,
    );
    expect(report).toContain("第 1 轮");
    expect(report).toContain("csv[0].mean.stdout");
    expect(report).toContain("L2\\artifacts\\expectation-comparison-result.json");
    // No passive "被检测/被停止" constructions for the verdict sentence.
    expect(report).toContain("我主动停止了");
  });
});
