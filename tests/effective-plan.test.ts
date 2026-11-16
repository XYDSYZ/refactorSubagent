import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  examHashOf,
  loadEffectivePlan,
  planFromCheckpointView,
  refreshExam,
  replaceBuild,
  saveEffectivePlan,
} from "../src/runtime/feedback/effective-plan.js";
import type { WorkflowsCheckpointView } from "../src/runtime/stage-resume.js";

/**
 * effective-plan — the loop's "currently valid full plan": build repairs
 * swap slots, exam repairs bump the version, baseline stamps move with the
 * exam. Persisted so the NEXT repair round reads the repaired state instead
 * of silently re-selecting round 1.
 */

function view(): WorkflowsCheckpointView {
  return {
    testEntry: "workflows/test.ts",
    entryRoot: null,
    testSourceHash: "exam-hash-1",
    workflowId: "exam",
    workflowRevision: 1,
    builds: [
      { id: "b1", entry: ".refactor/runs/s1/workflows/build/b1.ts", sourceHash: "b1-hash", runLocal: true },
      { id: "b2", entry: ".refactor/runs/s1/workflows/build/b2.ts", sourceHash: "b2-hash", runLocal: true },
    ],
  };
}

describe("effective-plan", () => {
  test("save/load roundtrip preserves the full plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "rfr-plan-"));
    try {
      const plan = { ...planFromCheckpointView(view(), "D:\\repo", "exam-hash-1") };
      saveEffectivePlan(dir, plan);
      const loaded = loadEffectivePlan(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.builds).toHaveLength(2);
      expect(loaded!.baselineExamHash).toBe("exam-hash-1");
      expect(loaded!.workflowId).toBe("exam");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt plan file reads as absent, never as reusable truth", () => {
    const dir = mkdtempSync(join(tmpdir(), "rfr-plan-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "effective-plan.json"), "{not json");
      expect(loadEffectivePlan(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("build repair replaces the attributed slot and keeps the rest", () => {
    const plan = planFromCheckpointView(view(), "D:\\repo", "exam-hash-1");
    const next = replaceBuild(plan, { id: "b1.r2", entry: ".refactor/runs/fb2-bw/build/b1.r2.ts" }, "b1");
    expect(next).not.toBeNull();
    expect(next!.builds.map((build) => build.id)).toEqual(["b1.r2", "b2"]);
    // The exam is untouched by a build repair: the baseline stamp carries.
    expect(next!.baselineExamHash).toBe(plan.baselineExamHash);
  });

  test("an unmappable build repair returns null instead of guessing", () => {
    const plan = planFromCheckpointView(view(), "D:\\repo", "exam-hash-1");
    expect(replaceBuild(plan, { id: "ghost", entry: "x.ts" }, "ghost")).toBeNull();
  });

  test("exam repair bumps the version and re-stamps the baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "rfr-plan-exam-"));
    try {
      mkdirSync(join(dir, "workflows"), { recursive: true });
      const plan = planFromCheckpointView(view(), dir, "exam-hash-1");
      // Seed a REAL exam file: refresh reads the new content from disk.
      writeFileSync(join(dir, "workflows", "test.ts"), "export const workflowKind = v2;\n");
      expect(examHashOf(plan, dir)).not.toBeNull();
      const next = refreshExam(plan, dir, 2);
      expect(next.workflowRevision).toBe(2);
      const refreshedHash = examHashOf(next, dir);
      expect(refreshedHash).not.toBeNull();
      expect(next.testSourceHash).toBe(refreshedHash ?? "");
      // The old stamp no longer matches: stored baseline reuse must stop.
      expect(next.baselineExamHash).not.toBe("exam-hash-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("baseline stamp goes stale when the exam changes without a repair round", () => {
    const dir = mkdtempSync(join(tmpdir(), "rfr-plan-stale-"));
    try {
      mkdirSync(join(dir, "workflows"), { recursive: true });
      writeFileSync(join(dir, "workflows", "test.ts"), "exam v1\n");
      const seeded = planFromCheckpointView(view(), dir, "");
      const hash = examHashOf(seeded, dir);
      if (hash === null) throw new Error("fixture exam file missing");
      const plan = planFromCheckpointView(view(), dir, hash);
      expect(examHashOf(plan, dir)).toBe(plan.baselineExamHash);
      // A stray edit (no repair round ran) invalidates the stamp.
      writeFileSync(join(dir, "workflows", "test.ts"), "exam v2 (stray edit)\n");
      expect(examHashOf(plan, dir)).not.toBe(plan.baselineExamHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
