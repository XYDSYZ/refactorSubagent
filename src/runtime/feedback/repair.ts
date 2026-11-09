import { runAgent } from "../../agents/driver.js";
import { REFACTOR_AGENT_TOOLS } from "../../agents/refactor.js";
import type { RefactorStage } from "../stage-flow.js";
import { halt } from "../stage-flow.js";
import type { RefactorTrigger, RepairEvidence } from "./types.js";

/**
 * feedback/repair — turn a routing decision into a repaired artifact.
 *
 * Phase 2 wires the refactor-dialogue continuation: the SAME SDK conversation
 * that authored the candidate receives the failure evidence and keeps editing
 * on top of its own last commit (the continuation carries the whole project
 * context, so no re-reading budget is spent). Build/test repair entries land
 * in later phases; their decisions stop honestly until then.
 */

/**
 * Compose the feedback message appended to the refactor dialogue. The message
 * carries black-box evidence only — what failed, where, and (for behavior
 * drift) the per-expectation diffs. It never describes the verifier.
 */
export function composeRefactorFeedback(
  trigger: RefactorTrigger,
  evidence: RepairEvidence,
  context: { candidateBranch: string; round: number },
): string {
  const lines: string[] = [];
  lines.push(`[第 ${String(context.round)} 轮反馈 — 系统自动追加]`);
  lines.push(
    `你的候选分支 ${context.candidateBranch} 没有通过验证。你的上一轮修改已经提交，` +
      "请在它的基础上继续修复，不要从原版重新完成整个任务。",
  );
  if (trigger === "candidate-build") {
    lines.push("失败原因：你修改后的代码编译失败（基线侧使用同一构建脚本编译成功）。");
    lines.push(`构建错误：${evidence.summary}`);
    lines.push("请修复编译错误，并保持改动最小。修完后自己先编译确认通过再结束。");
  } else if (trigger === "candidate-crash") {
    lines.push("失败原因：你修改后的程序在测试中崩溃或卡死（基线侧同一测试正常运行）。");
    lines.push(`崩溃证据：${evidence.summary}`);
    lines.push("请定位并修复崩溃，保持其余行为不变。");
  } else {
    lines.push("失败原因：两侧都运行成功，但以下可观察行为与基线不一致：");
    const mismatches = evidence.mismatches ?? [];
    if (mismatches.length > 0) {
      for (const mismatch of mismatches.slice(0, 40)) {
        lines.push(`- ${mismatch.name}：${mismatch.reason}`);
      }
      if (mismatches.length > 40) {
        lines.push(`…以及另外 ${String(mismatches.length - 40)} 条（见判决书文件）`);
      }
    } else {
      lines.push("-（比对器未给出结构化差异；请复查你改动的每一处行为的输入与输出）");
    }
    lines.push("请重新调整修改，使上面列出的每一条行为与基线完全一致；宁可少重构，也不要改变任何可观察行为。");
  }
  if (evidence.evidencePaths !== undefined && evidence.evidencePaths.length > 0) {
    lines.push(`证据文件（可读取）：${evidence.evidencePaths.join("、")}`);
  }
  return lines.join("\n");
}

/**
 * A refactor stage that CONTINUES an existing dialogue. The candidate worktree
 * is fresh from the branch (the pair is rebuilt per round), carrying the AI's
 * own last commit — the conversation's file history is relative to the same
 * content, so the model picks up where it left off. The host re-measures and
 * re-commits after the stage, exactly as for a first-round refactor.
 */
export function continuedRefactorStage(spec: {
  readonly dialogueId: string;
  readonly feedback: string;
  readonly maxTurns?: number | null;
  readonly model?: string | null;
  readonly timeoutMs?: number;
  readonly stallTimeoutMs?: number | null;
}): RefactorStage {
  return async (_ctx, input) => {
    const run = await runAgent({
      cwd: input.candidate.worktrees.candidateDir,
      prompt: spec.feedback,
      allowedTools: [...REFACTOR_AGENT_TOOLS],
      resumeSessionId: spec.dialogueId,
      ...(spec.maxTurns !== undefined && spec.maxTurns !== null ? { maxTurns: spec.maxTurns } : {}),
      ...(spec.model !== undefined && spec.model !== null ? { model: spec.model } : {}),
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.stallTimeoutMs !== undefined && spec.stallTimeoutMs !== null
        ? { stallTimeoutMs: spec.stallTimeoutMs }
        : {}),
    });
    if (run.resumeMismatch === true) {
      // A fresh chat answered — that is NOT a continuation. Fail loudly: the
      // budget must not pay for a session that lost the authoring context.
      return halt(
        `refactor dialogue resume failed: the SDK answered under a different conversation id (expected ${spec.dialogueId})`,
        {
          category: "model-session",
          component: "refactor-dialogue-resume",
          retryable: false,
          detail: { expected: spec.dialogueId },
        },
      );
    }
    if (run.isError && run.result.length === 0) {
      return halt("refactor dialogue continuation failed without a summary", {
        category: "model-session",
        component: "refactor-dialogue-resume",
        retryable: true,
        detail: { is_error: true, timed_out: run.timedOut, stalled: run.stalled === true },
      });
    }
    return {
      summary: run.result,
      ...(run.sessionId !== undefined ? { dialogueId: run.sessionId } : {}),
    };
  };
}
