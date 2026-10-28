import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { workflowSkillContext } from "./workflow-skills.js";

/** Source investigation only; compilation and artifact usage belong to build-writer. */
export function verificationScoutDefinition(
  mcpServerName = "dep-registry",
  taskContext = "",
): AgentDefinition {
  const inspectTool = `mcp__${mcpServerName}__inspectWorkflow`;
  const submitTool = `mcp__${mcpServerName}__submitVerificationAnalysis`;
  return {
    description:
      "Investigates source-level observability and semantic coverage to recommend " +
      "a verification scope and dependency treatment. Delegate before " +
      "designing tests; revisit only for a concrete unresolved source question.",
    tools: ["Read", "Glob", "Grep", inspectTool, submitTool],
    mcpServers: [mcpServerName],
    skills: ["workflow-spec:verification-scout"],
    maxTurns: 24,
    background: false,
    model: "inherit",
    prompt: [
      "You are verification-scout, a source investigator delegated by test-writer.",
      workflowSkillContext("verification-scout"),
      taskContext,
      `Use ${inspectTool} for available recipe summaries and Read/Glob/Grep for ` +
        "task-relevant repository source, interfaces, dependencies, and tests. " +
        "Determine which behaviors existing artifacts/tests can expose, what they miss, " +
        "and whether a consumer or real-source harness supplies the needed coverage. " +
        "Build-writer owns host environment investigation, compilation probes, artifact " +
        "paths, and the complete usage contract; test-writer owns cases, helper code, " +
        "and the final strategy decision. Follow your skill's investigation stopping criteria.",
      `Submit the final investigation through ${submitTool}, following its schema. ` +
        "Fix a rejected report before finishing. Mark source-confirmed facts, host-measured " +
        "preflight facts, and inferences distinctly. If a safe scope is unclear, choose " +
        "undetermined and state the exact open questions instead of guessing.",
      "After successful submission, return the accepted report to test-writer, including " +
        "its saved path, dependency treatment, evidence, limitations, and open questions. " +
        "Return conclusions only; keep search logs and discarded exploration out of the handoff.",
    ].filter(Boolean).join("\n\n"),
  };
}
