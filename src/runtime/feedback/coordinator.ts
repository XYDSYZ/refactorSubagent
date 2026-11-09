import type { StageFlowResult, WorkflowsStage } from "../stage-flow.js";
import { classifyFailureOwner, routeFailure, type RouterInput } from "./router.js";
import { composeRefactorFeedback } from "./repair.js";
import type { FeedbackDecision, RepairEvidence } from "./types.js";

/**
 * feedback/coordinator — the loop above the (immutable-verdict) state machine.
 *
 * Round 1 is a normal full run. A failed round is routed (router.ts); a
 * repair-refactor decision continues the ORIGINAL refactor dialogue with the
 * failure evidence and rebuilds from the candidate branch (pinned exam,
 * host-measured branch continuity). Every repair round is a NEW orchestrator
 * session — verdicts stay immutable; this loop coordinates above them.
 *
 * Budget: the initial round is free; every repair round consumes one unit,
 * success or failure. Stop conditions: ACCEPTED, budget exhausted, no
 * progress (identical repair artifact AND identical failure twice), any
 * stop/needs-diagnosis decision, or a repair kind this phase does not wire.
 */

export interface FeedbackLoopConfig {
  readonly baseTask: string;
  /** Total repair attempts allowed (the initial round is not counted). */
  readonly budget: number;
  /** Plain-language progress and final notices (stderr at the CLI). */
  readonly notify: (message: string) => void;
  /** Round 1: the normal full run (AI workflows, AI refactor, verify). */
  readonly runInitial: () => Promise<StageFlowResult>;
  /** Load round 1's pinned exam so repair rounds run the identical test
   *  workflow (null when its checkpoint no longer verifies on disk). */
  readonly loadPinnedWorkflows: () => WorkflowsStage | null;
  /**
   * Repair round: rebuild from the candidate branch with the pinned exam and
   * the CONTINUED refactor dialogue. The coordinator owns composition inputs
   * (dialogue id, branch, base, feedback); the caller owns stage plumbing.
   */
  readonly runRepairRound: (round: number, context: RepairRoundContext) => Promise<StageFlowResult>;
}

export interface RepairRoundContext {
  /** The refactor dialogue to continue (round 1's conversation). */
  readonly dialogueId: string;
  /** Candidate branch carrying the AI's last measured commit. */
  readonly candidateBranch: string;
  /** Base sha the branch grew from. */
  readonly baseSha: string;
  /** The pinned round-1 exam (null when its checkpoint no longer verifies). */
  readonly pinnedWorkflows: WorkflowsStage | null;
  /** Composed feedback message for the continued dialogue. */
  readonly feedback: string;
  /** Session id for this repair round. */
  readonly sessionId: string;
}

export interface FeedbackRoundOutcome {
  readonly round: number;
  readonly sessionId: string;
  readonly state: string;
  readonly decision: FeedbackDecision["kind"] | null;
  /** Identity of what this round produced (no-progress detection). */
  readonly artifactHash: string | null;
  readonly failureSignature: string | null;
}

export interface FeedbackLoopOutcome {
  readonly result: StageFlowResult;
  readonly rounds: readonly FeedbackRoundOutcome[];
  readonly stoppedBecause:
    | "accepted"
    | "budget-exhausted"
    | "no-progress"
    | "routed-stop"
    | "unwired-repair"
    | "missing-dialogue"
    | "missing-patch";
  /** The router's stop decision, when stoppedBecause is "routed-stop". */
  readonly stopDetail: string | null;
}

/** Extract the router input from a finished round (host-measured facts only). */
export function routerInputOf(result: StageFlowResult): RouterInput {
  const failure = result.failure;
  const component = failure?.component ?? "";
  const side: RouterInput["side"] = component.endsWith(":baseline")
    ? "baseline"
    : component.endsWith(":candidate")
      ? "candidate"
      : null;
  const comparison = result.verification?.expectationComparison ?? null;
  const mismatches = comparison === null
    ? []
    : comparison.declarations
        .filter((declaration) => !declaration.matched)
        .map((declaration) => ({ name: declaration.name, reason: declaration.reason }));
  return {
    state: result.state,
    failure: failure === null
      ? null
      : {
          stage: failure.stage,
          category: failure.category,
          component: failure.component,
          retryable: failure.retryable,
          reason: failure.reason,
          detail: failure.detail,
        },
    side,
    mismatches,
    failureOwner: failure === null ? null : classifyFailureOwner(failure.reason),
    evidencePaths: [
      `${result.logDir}\\artifacts\\expectation-comparison-result.json`,
      `${result.logDir}\\artifacts\\patch-candidate.json`,
    ],
  };
}

/** Cheap identity of what a round produced: the measured candidate commit. */
function artifactHashOf(result: StageFlowResult): string | null {
  return result.patch?.commit_sha ?? null;
}

/** Identity of how a round failed: the routed decision plus diff names. */
function failureSignatureOf(result: StageFlowResult): string | null {
  const input = routerInputOf(result);
  const decision = routeFailure(input);
  const names = input.mismatches.map((mismatch) => mismatch.name).sort().join("|");
  return `${decision.kind}:${names}`;
}

export async function runFeedbackLoop(config: FeedbackLoopConfig): Promise<FeedbackLoopOutcome> {
  const rounds: FeedbackRoundOutcome[] = [];
  let remaining = config.budget;

  const evaluate = (round: number, sessionId: string, result: StageFlowResult): FeedbackRoundOutcome => ({
    round,
    sessionId,
    state: result.state,
    decision: result.state === "ACCEPTED" ? null : routeFailure(routerInputOf(result)).kind,
    artifactHash: artifactHashOf(result),
    failureSignature: result.state === "ACCEPTED" ? null : failureSignatureOf(result),
  });

  // ---- Round 1: the initial execution (not budgeted) ----
  config.notify("第 1 轮执行开始：完整流水线（出卷、施工、验证）。");
  const firstSession = "round-1";
  let result = await config.runInitial();
  let record = evaluate(1, firstSession, result);
  rounds.push(record);

  while (true) {
    if (result.state === "ACCEPTED") {
      if (rounds.length > 1) {
        config.notify(`第 ${String(record.round)} 轮通过验收（ACCEPTED）——反馈修复起效，循环结束。`);
      }
      return { result, rounds, stoppedBecause: "accepted", stopDetail: null };
    }

    const decision = routeFailure(routerInputOf(result));

    if (decision.kind === "stop" || decision.kind === "needs-diagnosis") {
      const detail = decision.kind === "stop" ? decision.detail : decision.detail;
      config.notify(
        decision.kind === "stop"
          ? `循环停止（${decision.reason}）：${detail}`
          : `循环停止（无法分类）：${detail}`,
      );
      return { result, rounds, stoppedBecause: "routed-stop", stopDetail: detail };
    }

    // Phase 2 wires only the refactor-dialogue repair.
    if (decision.kind !== "repair-refactor") {
      config.notify(
        `路由判定为 ${decision.kind}，该修复通道尚未接线（Phase 3）；保留本轮结果后停止。`,
      );
      return { result, rounds, stoppedBecause: "unwired-repair", stopDetail: decision.kind };
    }

    if (remaining <= 0) {
      config.notify(`反馈预算已用完（${String(config.budget)} 次）；保留最后一轮真实结果。`);
      return { result, rounds, stoppedBecause: "budget-exhausted", stopDetail: null };
    }

    // No-progress brake: identical artifact AND identical failure twice.
    const previous = rounds.at(-2);
    const current = rounds.at(-1);
    if (
      previous !== undefined && current !== undefined &&
      previous.artifactHash !== null && current.artifactHash !== null &&
      previous.failureSignature !== null && current.failureSignature !== null &&
      previous.artifactHash === current.artifactHash &&
      previous.failureSignature === current.failureSignature
    ) {
      config.notify(
        "连续两轮的修复产物与失败签名完全相同——我判断对话已陷入循环，主动停止以免继续消耗额度。",
      );
      return { result, rounds, stoppedBecause: "no-progress", stopDetail: null };
    }

    // Repair-round inputs: the dialogue handle and the measured branch.
    const dialogueId = result.refactorDialogueId;
    const patch = result.patch;
    if (dialogueId === null) {
      config.notify("本轮没有可续写的重构对话句柄（会话未上报对话编号）；无法续写，停止。");
      return { result, rounds, stoppedBecause: "missing-dialogue", stopDetail: null };
    }
    if (patch === null) {
      config.notify("本轮没有宿主测量过的候选提交（patch 为空）；无法确定修复基线，停止。");
      return { result, rounds, stoppedBecause: "missing-patch", stopDetail: null };
    }

    remaining -= 1;
    const round = rounds.length + 1;
    const sessionId = `round-${String(round)}`;
    const pinnedWorkflows = config.loadPinnedWorkflows();
    if (pinnedWorkflows === null) {
      config.notify(
        "无法加载第 1 轮的考卷检查点（源文件缺失或损坏）——换一份新考卷会破坏轮间可比性，我停止了循环。",
      );
      return { result, rounds, stoppedBecause: "missing-patch", stopDetail: "pinned-exam-unavailable" };
    }
    const evidence: RepairEvidence = decision.evidence;
    const feedback = composeRefactorFeedback(decision.trigger, evidence, {
      candidateBranch: patch.branch,
      round,
    });
    config.notify(
      `第 ${String(round)} 轮反馈修复开始：我向原重构对话追加了失败证据` +
        `（${decision.trigger}），考卷沿用第 1 轮版本，从候选分支 ${patch.branch} 继续施工。` +
        `剩余预算 ${String(remaining)} 次。`,
    );

    result = await config.runRepairRound(round, {
      dialogueId,
      candidateBranch: patch.branch,
      baseSha: patch.base_sha,
      pinnedWorkflows,
      feedback,
      sessionId,
    });
    record = evaluate(round, sessionId, result);
    rounds.push(record);
  }
}
