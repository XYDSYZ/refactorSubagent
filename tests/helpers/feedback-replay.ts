/** Isolated SDK replay: real CLI, registry, workflows, Git and comparisons. */
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DriverOptions, DriverRun } from "../../src/agents/driver.js";
import { HostPreflight } from "../../src/artifacts/host-preflight.js";
import { installOwnedProcessSignalHandlers } from "../../shared/owned-process.js";
import { mcpText, withMcpClient } from "./mcp-client.js";
import { analysisReport } from "./verification-analysis.js";

installOwnedProcessSignalHandlers();
const [scenario, rootArg] = Bun.argv.slice(2);
assert(scenario && rootArg, "scenario and fixture root are required");
const root = resolve(rootArg);
const repo = join(root, "repo");
const sessionRoot = join(root, "state");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, ".gitignore"), ".refactor/\nbuild/\n");
writeFileSync(join(repo, ".gitattributes"), "* -text\n");
writeFileSync(join(repo, "main.c"), "int main(void) { return 0; }\n");
writeFileSync(join(repo, "output.txt"), "original");
for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "Test"], ["add", "."], ["commit", "-qm", "base"]]) {
  execFileSync("git", args, { cwd: repo, windowsHide: true });
}

const host = HostPreflight.parse({
  kind: "host-preflight", version: 1, platform: process.platform, arch: process.arch,
  shell: "unknown", supports_posix_shell: false,
  executable_suffix: process.platform === "win32" ? ".exe" : "",
  working_directory: repo, tools: {},
});
mock.module("../../src/runtime/host-preflight.js", () => ({ probeHost: () => host }));
const calls: { role: string; resume: string | null }[] = [];
let buildRepairs = 0;
let originalIds: string[] = [];
const freshSessions = new Map<string, number>();
const noProgress = scenario === "no-progress" || scenario.startsWith("cli-budget");
const testRepair = scenario === "test-refactor" || scenario === "cli-reauthor";
const codeRepair = scenario === "build-refactor" || testRepair || scenario === "cli-resume";
const recipe = (broken: boolean, name: string): string => `
export const workflowKind = "workflow-driven";
export default async (ctx) => {
  ${broken ? `throw new Error("broken recipe ${name}");` : 'await ctx.validator.assertFile("output.txt", "implementation output");'}
};
`;

mock.module("../../src/agents/driver.js", () => ({
  runAgent: async (options: DriverOptions): Promise<DriverRun> => {
    const isWriter = options.extraAllowedTools?.includes("mcp__dep-registry__declareDependency") === true;
    const isBuild = !isWriter && options.mcpServers !== undefined;
    const role = isWriter ? "writer" : isBuild ? "build" : "refactor";
    calls.push({ role, resume: options.resumeSessionId ?? null });
    const count = options.resumeSessionId === undefined ? (freshSessions.get(role) ?? 0) + 1 : 0;
    if (count > 0) freshSessions.set(role, count);
    const id = options.resumeSessionId ?? `${role}-dialogue${count === 1 ? "" : String(count)}`;
    if (options.resumeSessionId !== undefined) {
      assert(options.sessionStore, "a resumed role needs its original transcript store");
      assert(await options.sessionStore.load({ sessionId: id, projectKey: "replay" }), "original transcript was not found");
    }
    if (options.sessionStore !== undefined) {
      await options.sessionStore.append({ sessionId: id, projectKey: "replay" }, [{ uuid: `replay-${calls.length}`, type: "assistant" }]);
    }
    if (role === "refactor") {
      const repairing = options.resumeSessionId !== undefined;
      writeFileSync(join(options.cwd, "main.c"), `int main(void) { return 0; } /* ${repairing ? "repaired" : "refactored"} */\n`);
      writeFileSync(join(options.cwd, "output.txt"), !repairing && codeRepair ? "wrong" : "original");
    } else {
      const server = options.mcpServers?.["dep-registry"];
      assert(server?.type === "sdk");
      await withMcpClient(server, async (client) => {
        const generate = async (name: string, broken: boolean, material = "old") => {
          const result = await client.callTool({ name: "generateBuildWorkflow", arguments: {
            name, description: "prepare the fixture output", content: recipe(broken, name),
            materials: [{ path: "build/verification/input.txt", content: material }],
          } });
          assert(!result.isError, mcpText(result));
          const generatedId = /workflow_id:\s*(\S+)/.exec(mcpText(result))?.[1];
          assert(generatedId, mcpText(result));
          return generatedId;
        };
        if (isBuild) {
          const name = scenario === "build-pair" && buildRepairs > 0 ? "b" : "a";
          buildRepairs++;
          await generate(name, noProgress);
          return;
        }
        let ids: string[];
        if (options.resumeSessionId === undefined) {
          ids = [await generate("a", !testRepair)];
          if (scenario === "build-pair") ids.push(await generate("b", true));
          originalIds = ids;
        } else {
          // Use the real tool to resolve the earlier round's build before editing.
          const declared = await client.callTool({ name: "declareDependency", arguments: { buildWorkflowIds: originalIds } });
          assert(!declared.isError, mcpText(declared));
          ids = [await generate("a", false, "new")];
        }
        const declared = await client.callTool({ name: "declareDependency", arguments: { buildWorkflowIds: ids } });
        assert(!declared.isError, mcpText(declared));
        const analysis = await client.callTool({ name: "submitVerificationAnalysis", arguments: analysisReport() });
        assert(!analysis.isError, mcpText(analysis));
        const entry = /(?:written to exactly:\s*|写到原路径：)([^\r\n]+)/.exec(options.prompt)?.[1]?.trim();
        assert(entry, "missing test entry in authoring brief");
        mkdirSync(join(entry, ".."), { recursive: true });
        const broken = testRepair && options.resumeSessionId === undefined;
        writeFileSync(entry, `
export const workflowKind = "test-workflow-driven";
export default async (ctx) => {
  const value = await ctx.fs.${broken ? "read" : "readFile"}("output.txt");
  const input = await ctx.fs.readFile("build/verification/input.txt");
  ctx.expect("output", input + ":" + value);
};
`);
      });
    }
    return { result: "offline replay delivered", isError: false, timedOut: false, sessionId: id };
  },
}));

const { runFeedbackStageFlow } = await import("../../src/runtime/feedback/run.js");
const { runStageFlow } = await import("../../src/runtime/stage-flow.js");
const { loadWorkflowsCheckpointView } = await import("../../src/runtime/stage-resume.js");
const { workflowContentHash, loadEffectivePlan } = await import("../../src/runtime/feedback/effective-plan.js");
const { loadFeedbackState, loadFeedbackOwner } = await import("../../src/runtime/feedback/state.js");
const request = { repoPath: repo, task: "refactor the implementation without changing output", sessionRoot, sessionId: "first" };
const notifications: string[] = [];
let finalSession: string;
let outcome: Awaited<ReturnType<typeof runFeedbackStageFlow>> | null = null;
if (scenario === "cli-resume" || scenario === "cli-reauthor") {
  const first = await runStageFlow(request);
  assert.equal(first.state, "ABORTED");
  if (scenario === "cli-reauthor") {
    // Normal resume invalidation: the original authoring output was removed.
    unlinkSync(first.declared!.testResolution.entry);
  }
  finalSession = "first";
} else {
  outcome = await runFeedbackStageFlow(request, {
    budget: noProgress ? 3 : 4, resumeFrom: null, notify: (message) => notifications.push(message),
  });
  finalSession = outcome.rounds.at(-1)!.sessionId;
}
if (scenario.startsWith("cli-")) {
  const sourceSession = (scenario === "cli-resume" || scenario === "cli-reauthor") ? "first" : finalSession;
  Bun.argv.splice(0, Bun.argv.length, process.execPath, "scripts/cli.ts", "run", repo, "--task", request.task,
    "--session-root", sessionRoot, "--session", "recovered", "--resume", sourceSession,
    "--auto-retry", scenario === "cli-budget0" ? "0" : (scenario === "cli-resume" || scenario === "cli-reauthor") ? "3" : "1", "--format", "json");
  // The import executes the real argument parser and CLI branch.
  await import("../../scripts/cli.js");
  const owner = loadFeedbackOwner(sessionRoot, "recovered");
  const state = loadFeedbackState(join(sessionRoot, ".refactor", "feedback", owner));
  assert(state);
  finalSession = state.rounds.at(-1)!.sessionId;
}
const stateDir = join(sessionRoot, ".refactor", "feedback", loadFeedbackOwner(sessionRoot, finalSession));
const state = loadFeedbackState(stateDir);
assert(state);
const snapshots = state.rounds.map((round) => {
  const logDir = join(sessionRoot, ".refactor", "e2e", round.sessionId);
  const artifact = (name: string) => {
    const path = join(logDir, "artifacts", name);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  };
  const workflows = loadWorkflowsCheckpointView(repo, sessionRoot, round.sessionId);
  assert(workflows, "completed workflow checkpoint missing");
  return {
    session: round.sessionId, state: round.outcome,
    workflows, contentHash: workflowContentHash(workflows),
    baseline: artifact("expectation-baseline.json"),
    measuredBaseline: existsSync(join(logDir, "artifacts", "baseline-test-workflow-run.json")),
    failure: artifact("failure-report.json"),
  };
});
writeFileSync(join(root, "replay.json"), JSON.stringify({
  stoppedBecause: outcome?.stoppedBecause, notifications, calls, state, snapshots,
  plan: loadEffectivePlan(stateDir), owner: loadFeedbackOwner(sessionRoot, finalSession),
}, null, 2));
