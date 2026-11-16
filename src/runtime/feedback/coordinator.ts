import { join } from "node:path";
import { workflowContentHash } from "./effective-plan.js";
import type { StageFlowResult, WorkflowsStage } from "../stage-flow.js";
import type { ReusedExpectation } from "../workflow-pipeline.js";
import { classifyFailureOwner, routeFailure, type RouterInput } from "./router.js";
import { composeRefactorFeedback } from "./repair.js";
import type { FeedbackDecision, RepairEvidence } from "./types.js";
import { freshFeedbackState, loadFeedbackState, saveFeedbackState } from "./state.js";
import type { FeedbackState } from "./types.js";

/**
 * feedback/coordinator — the loop above the (immutable-verdict) state machine.
 *
 * Round 1 is a normal full run. A failed round is routed (router.ts); the
 * three repair lanes:
 *   refactor — CONTINUE the original refactor dialogue with the failure
 *              evidence, rebuild from the measured candidate branch, re-verify
 *              under the current pinned exam (baseline observations reusable).
 *   test     — CONTINUE the original authoring dialogue when the exam itself
 *              errored as a script; both sides re-run under the NEW exam.
 *   build    — a dedicated build-writer session repairs the failed build
 *              workflow (run-local revision); both sides rebuild under it,
 *              the candidate branch and exam stay.
 *
 * Budget: the initial round is free; every repair round consumes one unit,
 * success or failure. Stops: ACCEPTED, budget exhausted, no progress
 * (identical repair artifact AND identical failure twice), any stop /
 * needs-diagnosis decision, or a lane input the loop cannot honestly build.
 */

export interface FeedbackLoopConfig {
  readonly baseTask: string;
  /** Total repair attempts allowed (the initial round is not counted). */
  readonly budget: number;
  /** Plain-language progress and final notices (stderr at the CLI). */
  readonly notify: (message: string) => void;
  /** Round 1: the normal full run (AI workflows, AI refactor, verify). */
  readonly runInitial: () => Promise<StageFlowResult>;
  /** Load the current pinned exam so refactor/build repair rounds run the
   *  identical test workflow (null when its checkpoint no longer verifies). */
  readonly loadPinnedWorkflows: () => WorkflowsStage | null;
  /** Absolute path of the current exam entry (test-repair lane writes the
   *  fixed exam to the SAME path). Null when the checkpoint is unavailable. */
  readonly locateExamEntry: () => string | null;
  /** Compose the build-repair brief (needs the failed build's specifics from
   *  the current checkpoint). Null = checkpoint unavailable, stop honestly. */
  readonly composeBuildBrief: (evidence: RepairEvidence, round: number) => string | null;
  /** Run the dedicated build-repair session; null = it produced nothing. */
  readonly runBuildRepair: (brief: string, round: number) => Promise<{ id: string; entry: string } | null>;
  /** Load a previous round's measured baseline observations (refactor lane
   *  reuse). Null = unavailable, the round re-measures the baseline side. */
  readonly loadBaselineObservations: (previousSessionId: string, baseSha: string) => readonly ReusedExpectation[] | null;
  /** Durable state location (feedback-state.json); optional. */
  readonly stateDir?: string;
  /** State already loaded and enriched by the caller when resuming a run. */
  readonly initialState?: FeedbackState;
  /** Persist the run lineage before execution, and the measured plan afterwards. */
  readonly onRoundStarted?: (sessionId: string) => void;
  readonly onRoundCompleted?: (sessionId: string, result: StageFlowResult) => void;
  /** Current builds available to the continued test-writer's MCP tools. */
  readonly loadCurrentBuilds?: () => readonly { readonly id: string; readonly entry: string }[];
  /** Run one repair round with the composed lane context. */
  readonly runRepairRound: (round: number, context: RepairRoundContext) => Promise<StageFlowResult>;
  /**
   * REAL session id for a round number (the CLI owns id layout: base id for
   * round 1, `<base>-fb<N>` for repairs). Records, reuse loaders and the
   * durable state must use these ids — internal "round-N" labels do not name
   * any on-disk directory.
   */
  readonly sessionIdFor: (round: number) => string;
}

export type RepairRoundContext =
  | {
      lane: "refactor";
      dialogueId: string;
      candidateBranch: string;
      baseSha: string;
      pinnedWorkflows: WorkflowsStage;
      feedback: string;
      /** Previous round's baseline observations — reuse instead of
       *  re-measuring (guards verified by construction of this lane). */
      reusedBaseline: readonly ReusedExpectation[] | null;
      sessionId: string;
    }
  | {
      lane: "test";
      adoptBuilds: readonly { readonly id: string; readonly entry: string }[];
      dialogueId: string;
      testEntry: string;
      feedback: string;
      /** The measured candidate branch keeps carrying the unchanged code. */
      candidateBranch: string;
      baseSha: string;
      sessionId: string;
    }
  | {
      lane: "build";
      fixedBuild: { id: string; entry: string };
      /** Declared id of the build that failed (from the attribution; null
       *  when the round predated build-id attribution). */
      failedBuildId: string | null;
      candidateBranch: string;
      baseSha: string;
      pinnedWorkflows: WorkflowsStage;
      sessionId: string;
    };

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
    | "repair-failed"
    | "missing-dialogue"
    | "missing-patch"
    | "missing-input";
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
  const rawBuildId = failure?.detail["build_id"];
  const buildId: RouterInput["buildId"] = typeof rawBuildId === "string" && rawBuildId.length > 0
    ? rawBuildId
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
    buildId,
    mismatches,
    failureOwner: failure === null ? null : classifyFailureOwner(failure.reason),
    evidencePaths: [
      join(result.logDir, "artifacts", "expectation-comparison-result.json"),
      join(result.logDir, "artifacts", "patch-candidate.json"),
    ],
  };
}

/** Content identity stays stable when a repair re-registers identical sources. */
function artifactHashOf(result: StageFlowResult): string | null {
  if (result.declared === null) return result.patch?.commit_sha ?? null;
  const hash = workflowContentHash({
    testSourceHash: result.declared.testResolution.sourceHash,
    builds: result.declared.declaredSet.builds.map((build) => ({
      ...build, sourceHash: build.source_hash, runLocal: build.run_local, materials: build.materials ?? [],
    })),
  });
  return `${result.patch?.commit_sha ?? "no-commit"}:${hash}`;
}

/** Unbiased digest of the raw failure text so "build A broke" and "build B
 *  broke" never share a signature even when the routed decision matches. */
function reasonDigest(reason: string): string {
  let hash = 5381;
  for (let index = 0; index < reason.length; index++) {
    hash = ((hash << 5) + hash + reason.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Identity of how a round failed: the routed decision, the failing side and
 *  build (from the structured attribution), the raw error digest, and the
 *  behavior-diff names. Without the build id and error digest, "build A
 *  repaired, now build B fails" reads as two identical rounds. */
function failureSignatureOf(result: StageFlowResult): string | null {
  const input = routerInputOf(result);
  const decision = routeFailure(input);
  const names = input.mismatches.map((mismatch) => mismatch.name).sort().join("|");
  let reason = input.failure?.reason ?? "";
  let buildSlot = input.buildId ?? "none";
  for (const [index, build] of (result.declared?.declaredSet.builds ?? []).entries()) {
    // A new run-local id must not turn the same error into a new failure.
    reason = reason.replaceAll(build.id, `<build-${String(index)}>`);
    if (input.buildId === build.id) buildSlot = String(index);
  }
  return `${decision.kind}:${input.side ?? "none"}:${buildSlot}:${reasonDigest(reason)}:${names}`;
}

export async function runFeedbackLoop(config: FeedbackLoopConfig): Promise<FeedbackLoopOutcome> {
  const rounds: FeedbackRoundOutcome[] = [];
  // Durable budget: a re-launched loop for the same run keeps what it spent.
  let persisted = config.initialState
    ?? (config.stateDir !== undefined ? loadFeedbackState(config.stateDir) : null)
    ?? freshFeedbackState(config.budget);
  // Changing the total never erases attempts already spent.
  persisted = { ...persisted, budgetTotal: config.budget };
  let budgetUsed = persisted.budgetUsed;
  const firstRound = (persisted.rounds.at(-1)?.round ?? 0) + 1;
  /** Budget snapshot written IMMEDIATELY when a unit is consumed — an
   *  interrupted repair (crash, kill, model-session halt mid-round) must not
   *  look like unspent budget on the next launch. */
  const persistBudget = (): void => {
    const base = persisted;
    base.budgetUsed = budgetUsed;
    persisted = base;
    if (config.stateDir !== undefined) saveFeedbackState(config.stateDir, base);
  };
  const persist = (record: FeedbackRoundOutcome, result: StageFlowResult, lane: RepairRoundContext["lane"] | null): void => {
    const base = persisted;
    base.budgetUsed = budgetUsed;
    if (result.refactorDialogueId !== null) base.dialogues.refactor = result.refactorDialogueId;
    if (result.workflowsDialogueId !== null) base.dialogues.testWriter = result.workflowsDialogueId;
    // The audit trail: append the round (history is never rewritten).
    base.rounds = [
      ...base.rounds,
      {
        round: record.round,
        sessionId: record.sessionId,
        outcome: record.state === "ACCEPTED" || record.state === "REJECTED" ? record.state : "ABORTED",
        decision: record.decision,
        repair: lane,
        budgeted: lane !== null,
        artifactHash: record.artifactHash,
        failureSignature: record.failureSignature,
      },
    ];
    persisted = base;
    if (config.stateDir !== undefined) saveFeedbackState(config.stateDir, base);
  };

  const evaluate = (round: number, sessionId: string, result: StageFlowResult): FeedbackRoundOutcome => ({
    round,
    sessionId,
    state: result.state,
    decision: result.state === "ACCEPTED" ? null : routeFailure(routerInputOf(result)).kind,
    artifactHash: artifactHashOf(result),
    failureSignature: result.state === "ACCEPTED" ? null : failureSignatureOf(result),
  });

  // ---- Round 1: the initial execution (not budgeted) ----
  config.notify(`第 ${String(firstRound)} 轮执行开始。`);
  config.onRoundStarted?.(config.sessionIdFor(firstRound));
  let result = await config.runInitial();
  config.onRoundCompleted?.(config.sessionIdFor(firstRound), result);
  let record = evaluate(firstRound, config.sessionIdFor(firstRound), result);
  rounds.push(record);
  persist(record, result, null);

  while (true) {
    if (result.state === "ACCEPTED") {
      if (rounds.length > 1) {
        config.notify(`第 ${String(record.round)} 轮通过验收（ACCEPTED）——反馈修复起效，循环结束。`);
      }
      return { result, rounds, stoppedBecause: "accepted", stopDetail: null };
    }

    const decision = routeFailure(routerInputOf(result));

    if (decision.kind === "stop" || decision.kind === "needs-diagnosis") {
      config.notify(
        decision.kind === "stop"
          ? `循环停止（${decision.reason}）：${decision.detail}`
          : `循环停止（无法分类）：${decision.detail}`,
      );
      return { result, rounds, stoppedBecause: "routed-stop", stopDetail: decision.detail };
    }

    if (budgetUsed >= config.budget) {
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

    const round = firstRound + rounds.length;
    const sessionId = config.sessionIdFor(round);
    let context: RepairRoundContext;

    if (decision.kind === "repair-refactor") {
      // Durable dialogue handles: a lane that did not run the refactor AI
      // (e.g. the previous round was a build repair) keeps the id from the
      // last round that did, so lane SWITCHES continue the original chat.
      const dialogueId = result.refactorDialogueId ?? persisted.dialogues.refactor ?? null;
      const patch = result.patch;
      if (dialogueId === null) {
        config.notify("本轮没有可续写的重构对话句柄（会话未上报对话编号）；无法续写，停止。");
        return { result, rounds, stoppedBecause: "missing-dialogue", stopDetail: null };
      }
      if (patch === null) {
        config.notify("本轮没有宿主测量过的候选提交（patch 为空）；无法确定修复基线，停止。");
        return { result, rounds, stoppedBecause: "missing-patch", stopDetail: null };
      }
      const pinnedWorkflows = config.loadPinnedWorkflows();
      if (pinnedWorkflows === null) {
        config.notify("无法加载当前有效的验证方案——换新考卷会破坏轮间可比性，我停止了循环。");
        return { result, rounds, stoppedBecause: "missing-patch", stopDetail: "pinned-exam-unavailable" };
      }
      // Baseline reuse: every refactor-lane trigger (candidate build/crash,
      // behavior mismatch) implies the baseline side PASSED under this exact
      // pinned exam in the previous round, and repair rounds never move the
      // repo HEAD — so the previous baseline observations remain valid.
      // The loader receives the previous round's REAL session id.
      const reusedBaseline = config.loadBaselineObservations(rounds.at(-1)!.sessionId, patch.base_sha);
      const feedback = composeRefactorFeedback(decision.trigger, decision.evidence, {
        candidateBranch: patch.branch,
        round,
      });
      context = {
        lane: "refactor",
        dialogueId,
        candidateBranch: patch.branch,
        baseSha: patch.base_sha,
        pinnedWorkflows,
        feedback,
        reusedBaseline,
        sessionId,
      };
      budgetUsed += 1;
      persistBudget();
      config.notify(
        `第 ${String(round)} 轮反馈修复开始：我向原重构对话追加了失败证据（${decision.trigger}），` +
          `沿用当前验证方案，从候选分支 ${patch.branch} 继续施工` +
          (reusedBaseline !== null ? "，基线观测按守卫复用" : "") +
          `。剩余预算 ${String(config.budget - budgetUsed)} 次。`,
      );
    } else if (decision.kind === "repair-test") {
      const dialogueId = result.workflowsDialogueId ?? persisted.dialogues.testWriter ?? null;
      const testEntry = config.locateExamEntry();
      const patch = result.patch;
      if (dialogueId === null || testEntry === null) {
        config.notify("考卷对话句柄或考卷路径不可用，无法续写出题对话；停止。");
        return { result, rounds, stoppedBecause: "missing-input", stopDetail: null };
      }
      if (patch === null) {
        config.notify("本轮没有宿主测量过的候选提交（patch 为空）；无法保留候选分支，停止。");
        return { result, rounds, stoppedBecause: "missing-patch", stopDetail: null };
      }
      const feedback = composeTestFeedback(decision.evidence, { round, testEntry });
      context = {
        lane: "test",
        adoptBuilds: config.loadCurrentBuilds?.() ?? [],
        dialogueId,
        testEntry,
        feedback,
        candidateBranch: patch.branch,
        baseSha: patch.base_sha,
        sessionId,
      };
      budgetUsed += 1;
      persistBudget();
      config.notify(
        `第 ${String(round)} 轮反馈修复开始：考卷脚本自身出错，我向原出题对话追加了错误证据；` +
          `两侧将在修复后的同一版考卷下重新验证。剩余预算 ${String(config.budget - budgetUsed)} 次。`,
      );
    } else {
      // decision.kind === "repair-build"
      const patch = result.patch;
      if (patch === null) {
        config.notify("本轮没有宿主测量过的候选提交（patch 为空）；无法保留候选分支，停止。");
        return { result, rounds, stoppedBecause: "missing-patch", stopDetail: null };
      }
      const brief = config.composeBuildBrief(decision.evidence, round);
      if (brief === null) {
        config.notify("无法组装构建修复简报（检查点不可用）；停止。");
        return { result, rounds, stoppedBecause: "missing-input", stopDetail: null };
      }
      // Consume the budget unit BEFORE dispatching the repair session: a
      // session that tries and fails (or a run interrupted mid-repair) has
      // still spent the attempt, and the durable state must say so.
      budgetUsed += 1;
      persistBudget();
      config.notify(`第 ${String(round)} 轮构建方案修复开始：我派出了构建修理工。`);
      const fixed = await config.runBuildRepair(brief, round);
      if (fixed === null) {
        config.notify("构建修理工没有交付可用的修复方案（环境问题或无法修复）；停止并保留证据。");
        return { result, rounds, stoppedBecause: "repair-failed", stopDetail: null };
      }
      const pinnedWorkflows = config.loadPinnedWorkflows();
      if (pinnedWorkflows === null) {
        config.notify("无法加载当前有效的验证方案；构建修复后无法保持考卷一致，停止。");
        return { result, rounds, stoppedBecause: "missing-patch", stopDetail: "pinned-exam-unavailable" };
      }
      context = {
        lane: "build",
        fixedBuild: fixed,
        failedBuildId: decision.evidence.buildId ?? null,
        candidateBranch: patch.branch,
        baseSha: patch.base_sha,
        pinnedWorkflows,
        sessionId,
      };
      config.notify(
        `构建修理工交付了修复方案 ${fixed.id}；两侧将重新构建并重新验证。剩余预算 ${String(config.budget - budgetUsed)} 次。`,
      );
    }

    config.onRoundStarted?.(sessionId);
    result = await config.runRepairRound(round, context);
    config.onRoundCompleted?.(sessionId, result);
    record = evaluate(round, sessionId, result);
    rounds.push(record);
    persist(record, result, context.lane);
  }
}

/** Feedback message for the continued authoring dialogue (script-error lane). */
function composeTestFeedback(evidence: RepairEvidence, context: { round: number; testEntry: string }): string {
  const lines: string[] = [];
  lines.push(`[第 ${String(context.round)} 轮反馈 — 系统自动追加]`);
  lines.push("你编写的 TestWorkflow 在执行时自身出错了（脚本错误，不是被测程序的行为问题）。");
  lines.push(`错误证据：${evidence.summary}`);
  if (evidence.side !== undefined) {
    lines.push(`出错的一侧：${evidence.side === "baseline" ? "基线（原代码）" : "候选（新代码）"}。`);
  }
  if (evidence.evidencePaths !== undefined && evidence.evidencePaths.length > 0) {
    lines.push(`日志与证据路径（可读取）：${evidence.evidencePaths.join("、")}`);
  }
  lines.push("请修复脚本的执行错误（路径、API 用法、语法等），并保持考卷的覆盖面不缩水。");
  return lines.join("\n");
}
