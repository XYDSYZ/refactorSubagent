import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRubric } from "../testset/runner/rubric.js";

test("rubric receives repository writer sources, registered helpers and a reference file", async () => {
  const root = mkdtempSync(join(tmpdir(), "rfr-rubric-"));
  try {
    const repo = join(root, "repo");
    const workflows = join(repo, ".refactor", "runs", "fixture", "workflows");
    mkdirSync(join(workflows, "test"), { recursive: true });
    mkdirSync(join(workflows, "build"), { recursive: true });
    writeFileSync(join(workflows, "test", "test-workflow.ts"), "export default async ctx => ctx.expect('observed-contract', 1);\n");
    const build = join(workflows, "build", "fixture.ts");
    writeFileSync(build, "export default async ctx => ctx.process.run({program: 'gcc'});\n");
    writeFileSync(`${build}.materials.json`, JSON.stringify({ version: 1, materials: [
      { path: "build/verification/mock.c", content: "int transport_read_fixture(void) { return -2; }\n" },
    ] }));
    const reference = join(root, "reference.md");
    writeFileSync(reference, "Check the transport dependency boundary.\n");
    const rubric = await runRubric({ command: null, caseId: "fixture", caseDir: join(root, "results"),
      sessionRoot: join(root, "session"), repoDir: repo, sessionId: "fixture", rubricPath: "",
      referencePath: reference, timeoutMs: 1000, evidence: "", minScore: null });
    expect(rubric.status).toBe("pending");
    const prompt = readFileSync(rubric.promptPath, "utf8");
    expect(prompt).toContain("observed-contract");
    expect(prompt).toContain("transport_read_fixture");
    expect(prompt).toContain("Check the transport dependency boundary.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reevaluation requires saved independent verification and retains its failure", () => {
  const root = mkdtempSync(join(tmpdir(), "rfr-independent-"));
  try {
    const resource = join(root, "resources", "reference");
    mkdirSync(resource, { recursive: true });
    writeFileSync(join(resource, "manifest.json"), JSON.stringify({ builds: [{ id: "ref", entry: "build.ts" }], testEntry: "test.ts" }));
    for (const file of ["build.ts", "test.ts"]) writeFileSync(join(resource, file), "export default () => {};\n");
    const runDir = join(root, "results");
    for (const id of ["passed", "failed", "missing"]) {
      const dir = join(root, "cases", id), evidence = join(runDir, id);
      mkdirSync(dir, { recursive: true }); mkdirSync(evidence, { recursive: true });
      writeFileSync(join(dir, "task.txt"), "refactor fixture\n");
      writeFileSync(join(dir, "case.json"), JSON.stringify({ id, prepare: null, task: "./task.txt",
        verification: { resource: "reference", inject: [], changedFiles: ["src/fixture.c"] },
        expect: { method: "verdict", state: "ACCEPTED" },
      }));
      writeFileSync(join(evidence, "run-result.json"), JSON.stringify({
        status: "exited", exitCode: 0, elapsedMs: 1, summary: { state: "ACCEPTED", comparison: "consistent" },
        mismatches: [], comparisonErrors: [], envDir: null, logDir: null, comparisonPath: null, pipelinePath: null, error: null,
        ...(id === "missing" ? {} : { independentVerification: { status: id, detail: "fixed reference " + id,
          logDir: null, state: id === "passed" ? "ACCEPTED" : "REJECTED", changedFiles: ["src/fixture.c"], mismatches: [] } }),
      }));
    }
    const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../testset/run.ts"),
      "--root", root, "--reevaluate", runDir], { stdout: "pipe", stderr: "pipe", timeout: 15000 });
    expect(result.exitCode, result.stderr.toString()).toBe(1);
    const summary = JSON.parse(readFileSync(join(runDir, "summary.reevaluated.json"), "utf8"));
    expect(summary.counts.passed).toBe(1);
    expect(summary.counts.failed).toBe(2);
    const pass = summary.cases.find((c: { id: string }) => c.id === "passed");
    expect(pass.observed.independentVerification.detail).toBe("fixed reference passed");
    for (const id of ["failed", "missing"]) {
      const c = summary.cases.find((c: { id: string }) => c.id === id);
      expect(c.checks).toContainEqual(expect.objectContaining({ name: "independent-verification", ok: false }));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
