import type { StageFlowResult } from "./stage-flow.js";

/**
 * auto-retry — bounded, program-orchestrated re-runs after a REJECTED verdict.
 *
 * When the AI's refactor changes observable behavior (REJECTED), the verdict
 * carries a precise, per-expectation diff. This module loops:
 *
 *   round 1  run as usual
 *   round N  compose a NEW task = original task + the previous round's
 *            mismatch list (black-box behavior diffs, never verifier
 *            internals) and run a FRESH session (R7: a verdict is terminal,
 *            so a retry is a new exam, not a resumed one)
 *
 * Guardrails (why this does not decay into verifier-gaming):
 *   - hard round cap (caller-provided maxRetries)
 *   - every round is a brand-new session with no memory except the lesson
 *   - the lesson lists WHAT drifted, never HOW the checker works
 *   - identical failure signature on consecutive rounds → stop: the AI is
 *     stuck in a loop and further rounds only burn budget
 *   - ABORTED never retries (different failure class — the user's --resume
 *     path owns environment/host failures)
 *
 * Every stop notifies the user in plain language.
 */

/** One failed expectation, reduced to what the next round may learn from. */
export interface BehaviorMismatch {
  readonly name: string;
  readonly reason: string;
}

export interface RetryRoundRecord {
  readonly round: number;
  readonly sessionId: string;
  readonly state: string;
  readonly mismatches: readonly BehaviorMismatch[];
  readonly signature: string | null;
  readonly logDir: string;
}

export type AutoRetryStopReason =
  | "accepted"
  | "aborted"
  | "loop-detected"
  | "rounds-exhausted"
  | "no-verdict";

export interface AutoRetryOutcome {
  /** The result of the FINAL round (accepted, or the last attempt). */
  readonly result: StageFlowResult;
  readonly rounds: readonly RetryRoundRecord[];
  readonly stoppedBecause: AutoRetryStopReason;
  /** Plain-language report for the user; the module also emits it via notify. */
  readonly report: string;
}

export interface AutoRetryConfig {
  /** The original task text (round 1 runs exactly this). */
  readonly baseTask: string;
  /** Maximum ADDITIONAL rounds after the first one (0 = no retry). */
  readonly maxRetries: number;
  /** Run one round. The module owns task composition and session ids. */
  readonly runRound: (round: number, task: string, sessionId: string) => Promise<StageFlowResult>;
  /** Session id for a round (round 1 keeps the caller's base id). */
  readonly makeSessionId: (round: number) => string;
  /** Progress / final notifications, in plain language. */
  readonly notify: (message: string) => void;
}

/** Collect the failed expectations from a verdict (empty when unstructured). */
export function extractMismatches(result: StageFlowResult): BehaviorMismatch[] {
  const comparison = result.verification?.expectationComparison ?? null;
  if (comparison === null) return [];
  return comparison.declarations
    .filter((declaration) => !declaration.matched)
    .map((declaration) => ({ name: declaration.name, reason: declaration.reason }));
}

/** Stable identity of a failure: which behaviors drifted (order-independent). */
export function signatureOf(mismatches: readonly BehaviorMismatch[]): string | null {
  if (mismatches.length === 0) return null;
  return mismatches
    .map((mismatch) => mismatch.name)
    .sort()
    .join("|");
}

/**
 * Compose the next round's task: the original task plus the previous round's
 * behavior diffs. The lesson says WHAT must stay identical; it never describes
 * the verification machinery.
 */
export function composeRetryTask(
  baseTask: string,
  round: number,
  mismatches: readonly BehaviorMismatch[],
): string {
  const lesson = mismatches.length > 0
    ? mismatches.map((mismatch) => `- ${mismatch.name}：${mismatch.reason}`).join("\n")
    : "- 上一轮的行为验证未通过（比对器未给出结构化差异，请自行复查你修改过的每一处行为的输入与输出）。";
  return [
    baseTask,
    "",
    `[第 ${round} 轮重试 — 系统自动追加的教训]`,
    `上一轮（第 ${round - 1} 轮）的重构没有通过行为验证：你修改代码之后，以下可观察行为偏离了基线：`,
    lesson,
    "本轮请重新完成上面的原任务，并且保持上面列出的每一条行为与基线完全一致。",
    "如果你不确定如何做到，请缩小改动范围：宁可少重构，也不要改变任何可观察行为。",
  ].join("\n");
}

/**
 * The plain-language give-up report. Sentences keep the subject next to its
 * verb and speak in first person ("我检测到…我停止了"), so a human skims it
 * without parsing.
 */
export function composeGiveUpReport(rounds: readonly RetryRoundRecord[], stoppedBecause: AutoRetryStopReason, maxRetries: number): string {
  const lines: string[] = [];
  lines.push(`自动重试已结束：我一共运行了 ${String(rounds.length)} 轮。`);
  for (const round of rounds) {
    if (round.state === "REJECTED") {
      const top = round.mismatches.slice(0, 3).map((mismatch) => mismatch.name).join("、");
      lines.push(`- 第 ${String(round.round)} 轮：验证未通过${top.length > 0 ? `，差异集中在 ${top}` : ""}。`);
    } else {
      lines.push(`- 第 ${String(round.round)} 轮：${round.state}。`);
    }
  }
  const last = rounds.at(-1);
  if (stoppedBecause === "loop-detected") {
    lines.push(
      "我判断重试已经陷入循环：连续两轮在同一批行为上失败，继续重试大概率不会带来改善，所以我主动停止了。",
    );
  } else {
    lines.push(`我已经用完您允许的重试次数（${String(maxRetries)} 次），所以停止了。`);
  }
  lines.push("建议您按下面三步继续：");
  if (last !== undefined) {
    lines.push(`1. 打开判决书查看逐条差异：${last.logDir}\\artifacts\\expectation-comparison-result.json；`);
  } else {
    lines.push("1. 查看运行日志目录下的 expectation-comparison-result.json；");
  }
  lines.push("2. 修改任务描述，明确写出必须保持的行为；");
  lines.push("3. 重新发起一次全新的运行。");
  return lines.join("\n");
}

/** Run the bounded retry loop. See the module comment for the guardrails. */
export async function runWithAutoRetry(config: AutoRetryConfig): Promise<AutoRetryOutcome> {
  const rounds: RetryRoundRecord[] = [];
  let previousSignature: string | null = null;
  let previousMismatches: readonly BehaviorMismatch[] = [];

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const round = attempt + 1;
    const sessionId = config.makeSessionId(round);
    const task = attempt === 0
      ? config.baseTask
      : composeRetryTask(config.baseTask, round, previousMismatches);
    if (attempt > 0) {
      config.notify(
        `第 ${String(round)} 轮重试开始：我把上一轮的 ${String(previousMismatches.length)} 条失败差异写进了任务描述。`,
      );
    }

    const result = await config.runRound(round, task, sessionId);
    const mismatches = extractMismatches(result);
    const signature = signatureOf(mismatches);
    rounds.push({
      round,
      sessionId,
      state: result.state,
      mismatches,
      signature,
      logDir: result.logDir,
    });

    if (result.state === "ACCEPTED") {
      if (attempt > 0) {
        config.notify(`第 ${String(round)} 轮通过了验收（ACCEPTED）——教训起作用了，我停止重试。`);
      }
      return { result, rounds, stoppedBecause: "accepted", report: "" };
    }

    if (result.state === "ABORTED") {
      const failure = result.failure;
      const where = failure === null ? result.state : `[${failure.category}] ${failure.component}`;
      config.notify(
        [
          `第 ${String(round)} 轮在给出行为判决之前就中止了（${where}）。`,
          "这类失败不属于「改错行为」，自动重试解决不了它。",
          `请您先按原因处理环境或配置，然后用 --resume ${sessionId} 复工；AI 已完成的产物会直接复用。`,
        ].join("\n"),
      );
      return { result, rounds, stoppedBecause: "aborted", report: "" };
    }

    if (result.state !== "REJECTED") {
      config.notify(`第 ${String(round)} 轮以状态 ${result.state} 结束，不属于可重试的失败，我停止了。`);
      return { result, rounds, stoppedBecause: "no-verdict", report: "" };
    }

    if (attempt > 0 && signature !== null && signature === previousSignature) {
      const report = composeGiveUpReport(rounds, "loop-detected", config.maxRetries);
      config.notify(report);
      return { result, rounds, stoppedBecause: "loop-detected", report };
    }

    if (attempt === config.maxRetries) {
      const report = composeGiveUpReport(rounds, "rounds-exhausted", config.maxRetries);
      config.notify(report);
      return { result, rounds, stoppedBecause: "rounds-exhausted", report };
    }

    previousSignature = signature;
    previousMismatches = mismatches;
  }
  // Unreachable (the loop always returns on the last attempt).
  throw new Error("auto-retry loop exited without a verdict");
}
