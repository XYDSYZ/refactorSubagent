/** Validate benchmark truth through the public CLI, without model calls. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runPipelineCase, type JobContext } from "../testset/runner/drivers.js";
import { prepareEnvironment } from "../testset/runner/env.js";
import { evaluatePipeline } from "../testset/runner/evaluate.js";
import { loadSuite, type SuiteCase } from "../testset/runner/suite.js";
import { readJson, writeJson } from "../testset/runner/util.js";

interface Control { id: string; patch: string; state: string; failuresRequired: string[]; description: string }
const root = resolve(import.meta.dir, "../testset");
let output: string | null = null;
let only: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const value = () => { const next = process.argv[++i]; if (!next) throw new Error("missing value for " + arg); return next; };
  if (arg === "--out") output = resolve(value());
  else if (arg === "--only") only = value().split(",");
  else throw new Error("usage: bun scripts/calibrate-project-cases.ts --out <new-directory> [--only <case-id,...>]");
}
if (!output) throw new Error("--out must name a fresh evidence directory");
if (existsSync(output)) throw new Error("evidence directory already exists: " + output);
const { suite } = loadSuite(root);
if (suite.problems.length) throw new Error(JSON.stringify(suite.problems));
const cases = suite.cases.filter(c => c.tags.includes("project-evaluation") && (!only.length || only.includes(c.id)));
if (!cases.length || only.some(id => !cases.some(c => c.id === id))) throw new Error("unknown or empty case selection");
mkdirSync(output, { recursive: true });
const rows: Record<string, unknown>[] = [];
let allPassed = true;
let expectedControls = 0;
for (const c of cases) {
  const spec = c.verification;
  if (!spec) throw new Error("case needs independent verification: " + c.id);
  const raw = JSON.parse(readFileSync(join(c.dir, "case.json"), "utf8")) as { verification: { resource: string } };
  const controls = readJson<{ controls: Control[] }>(join(root, "resources", raw.verification.resource, "controls.json")).controls;
  if (!controls.length) throw new Error("no controls: " + c.id);
  expectedControls += controls.length;
  const caseDir = join(output, c.id);
  mkdirSync(caseDir, { recursive: true });
  console.log("prepare " + c.id);
  const prepared = await prepareEnvironment(c, caseDir, { testRoot: root, timeoutMs: 300000 });
  writeJson(join(caseDir, "prepare.json"), prepared);
  if (prepared.status !== "prepared") {
    rows.push({ case: c.id, status: prepared.status, reason: prepared.reason });
    allPassed = false;
    continue;
  }
  for (const control of controls) {
    const started = Date.now();
    const evidence = join(caseDir, control.id);
    mkdirSync(evidence, { recursive: true });
    const ctx: JobContext = { caseDir: evidence, testRoot: root, harnessDir: resolve(root, ".."),
      harnessCli: resolve(root, "../scripts/cli.ts"), bun: process.execPath, repeats: 1, rebuild: true,
      startedAt: started, onPhase: () => {} };
    const referenceCase: SuiteCase = { ...c, id: c.id + "-" + control.id,
      verification: control.state === "ACCEPTED" ? spec : undefined,
      inject: spec.inject, stages: { ...spec.stages, refactor: { mode: "patch", patchFile: join(root, control.patch) } },
      timeoutMs: 720000,
      expect: { method: "verdict+attribution", state: control.state, failuresRequired: control.failuresRequired,
        injectedStages: ["workflows", "refactor"], authoritative: true },
    };
    try {
      console.log("run " + c.id + "/" + control.id);
      const run = await runPipelineCase(ctx, referenceCase, readFileSync(c.taskFile!, "utf8"),
        { repoDir: prepared.repoDir!, independent: control.state === "ACCEPTED" });
      writeJson(join(evidence, "run-result.json"), run);
      const evaluation = evaluatePipeline(referenceCase, run, { calibrate: false }, null);
      let baselineChecks = 0;
      let baselineValid = false;
      let candidateValid = false;
      if (run.logDir && existsSync(join(run.logDir, "artifacts", "baseline-test-workflow-run.json"))) {
        const baseline = readJson<{ status: string; expectations: { relation: string; value: unknown; pattern?: string }[] }>(
          join(run.logDir, "artifacts", "baseline-test-workflow-run.json"));
        baselineChecks = baseline.expectations.filter(e => e.relation === "both-matches").length;
        baselineValid = baseline.status === "pass" && baselineChecks > 0 && baseline.expectations.every(e =>
          e.relation !== "both-matches" || (typeof e.pattern === "string" && new RegExp(e.pattern).test(String(e.value))));
        const candidatePath = join(run.logDir, "artifacts", "candidate-test-workflow-run.json");
        candidateValid = existsSync(candidatePath) && readJson<{ status: string }>(candidatePath).status === "pass";
      }
      const ok = evaluation.status === "passed" && run.summary?.baseline_build === "pass"
        && run.summary.candidate_build === "pass" && baselineValid && candidateValid;
      allPassed &&= ok;
      const row = { case: c.id, control: control.id, description: control.description, passed: ok,
        expected: control.state, state: run.summary?.state ?? null, baselineBuild: run.summary?.baseline_build,
        candidateBuild: run.summary?.candidate_build, baselineValid, candidateValid, baselineChecks,
        mismatches: run.mismatches, checks: evaluation.checks, logDir: run.logDir, seconds: (Date.now() - started) / 1000 };
      rows.push(row);
      console.log(JSON.stringify({ case: c.id, control: control.id, passed: ok, state: row.state,
        baselineValid, candidateValid, mismatches: row.mismatches, seconds: row.seconds }));
      if (!baselineValid) {
        console.error("invalid baseline; remaining controls for this case were not run");
        break;
      }
    } catch (error) {
      allPassed = false;
      rows.push({ case: c.id, control: control.id, passed: false, error: error instanceof Error ? error.message : String(error) });
      console.error(c.id + "/" + control.id + ": " + String(error));
    }
    writeJson(join(output, "summary.json"), { modelCalls: 0, complete: false, passed: false, expectedControls, rows });
  }
}
const complete = rows.length === expectedControls && rows.every(row => "control" in row);
writeJson(join(output, "summary.json"), { modelCalls: 0, complete, passed: complete && allPassed, expectedControls, rows });
if (!complete || !allPassed) process.exitCode = 1;
