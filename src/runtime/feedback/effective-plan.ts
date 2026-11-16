import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowsCheckpointView } from "../stage-resume.js";

/**
 * effective-plan — the loop's "currently valid full plan".
 *
 * The round-1 checkpoint is immutable history; repairs move the plan FORWARD:
 * a build repair replaces its slot, an exam repair bumps the exam version,
 * and every later round (execution, re-repair, observation reuse) reads this
 * file instead of re-deriving from round 1 — otherwise repair N's work is
 * silently undone by repair N+1 re-selecting the round-1 source.
 *
 * Build entries are repo-relative (the declared-set convention); the exam is
 * relative to `entryRoot` (null = repo root). `baselineExamHash` stamps which
 * exam version the stored baseline observations were measured under —
 * baseline reuse is honest only while the exam still hashes to it.
 */

export interface EffectivePlan {
  readonly entryRoot: string | null;
  readonly testEntry: string;
  readonly testSourceHash: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly builds: readonly {
    readonly id: string;
    readonly entry: string;
    readonly sourceHash: string;
    readonly runLocal: boolean;
  }[];
  readonly baselineExamHash: string;
}

const FILE_NAME = "effective-plan.json";

export function effectivePlanPath(stateDir: string): string {
  return join(stateDir, FILE_NAME);
}

export function loadEffectivePlan(stateDir: string): EffectivePlan | null {
  const path = effectivePlanPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as EffectivePlan;
    if (
      parsed === null || typeof parsed !== "object" ||
      typeof parsed.testEntry !== "string" || typeof parsed.testSourceHash !== "string" ||
      !Array.isArray(parsed.builds) || typeof parsed.baselineExamHash !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveEffectivePlan(stateDir: string, plan: EffectivePlan): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(effectivePlanPath(stateDir), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

function sha256SourceFile(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex");
}

/** Current hash of the plan's exam source; null when the file went missing. */
export function examHashOf(plan: EffectivePlan, repoRoot: string): string | null {
  const exam = join(plan.entryRoot ?? repoRoot, plan.testEntry);
  if (!existsSync(exam)) return null;
  return sha256SourceFile(exam);
}

/** Seed the plan from a verified round-1 checkpoint view. */
export function planFromCheckpointView(
  view: WorkflowsCheckpointView,
  repoRoot: string,
  baselineExamHash: string,
): EffectivePlan {
  const exam = join(view.entryRoot ?? repoRoot, view.testEntry);
  return {
    entryRoot: view.entryRoot,
    testEntry: view.testEntry,
    testSourceHash: view.testSourceHash ?? (existsSync(exam) ? sha256SourceFile(exam) : ""),
    workflowId: view.workflowId,
    workflowRevision: view.workflowRevision,
    builds: view.builds.map((build) => ({ ...build })),
    baselineExamHash,
  };
}

/**
 * A delivered build repair replaces its slot. Same mapping rules as the
 * round execution: a single declared build is replaced outright; with
 * several, the failed slot is located by id; null when it cannot be mapped
 * honestly (the caller stops instead of guessing).
 */
export function replaceBuild(
  plan: EffectivePlan,
  fixedBuild: { readonly id: string; readonly entry: string },
  failedBuildId: string | null,
): EffectivePlan | null {
  const sourceHash = existsSync(fixedBuild.entry) ? sha256SourceFile(fixedBuild.entry) : "";
  const repaired = { id: fixedBuild.id, entry: fixedBuild.entry, sourceHash, runLocal: true };
  let builds: EffectivePlan["builds"];
  if (plan.builds.length === 1) {
    builds = [repaired];
  } else {
    const targetId = failedBuildId ?? fixedBuild.id;
    const index = plan.builds.findIndex((build) => build.id === targetId);
    if (index < 0) return null;
    builds = plan.builds.map((build, position) => (position === index ? repaired : { ...build }));
  }
  const exam = join(plan.entryRoot ?? process.cwd(), plan.testEntry);
  return {
    ...plan,
    builds,
    baselineExamHash: existsSync(exam) ? sha256SourceFile(exam) : plan.baselineExamHash,
  };
}

/**
 * An exam repair bumps the exam version: refresh the recorded hash and
 * revision, and RE-STAMP the baseline — this round re-measured both sides
 * under the new exam, so the stored observations are honest for it.
 */
export function refreshExam(
  plan: EffectivePlan,
  repoRoot: string,
  workflowRevision: number,
): EffectivePlan {
  const hash = examHashOf(plan, repoRoot);
  return {
    ...plan,
    workflowRevision: workflowRevision > 0 ? workflowRevision : plan.workflowRevision,
    testSourceHash: hash ?? plan.testSourceHash,
    baselineExamHash: hash ?? plan.baselineExamHash,
  };
}
