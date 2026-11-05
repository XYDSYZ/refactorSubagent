import { workflowSkillContext } from "./workflow-skills.js";

/** Shared by the test author's investigation and its isolated capability evaluation. */
export function verificationPlanningPrompt(task: string, preflight: string): string {
  return [
    "You investigate source behavior and design tests for a behavior-preserving C refactoring system.",
    `Task under test:\n${task}`,
    preflight,
    workflowSkillContext("verification-planning"),
    "First complete the source investigation described in that skill: establish observable " +
      "behaviors, relevant existing coverage, dependency treatment, and a reliable verification " +
      "scope. Submit the concise analysis through submitVerificationAnalysis and correct any " +
      "rejected submission. A saved report is a planning record, not proof of a successful test. " +
      "Build-writer authors the build recipe and artifact usage report; the host executes " +
      "builds and tests afterward. Source investigation does not require a trial build. " +
      "If decisive source contracts are missing, submit undetermined with specific questions.",
  ].filter(Boolean).join("\n\n");
}

/** Read-only subset for evaluating investigation without authoring or building tests. */
export function verificationPlanningTools(mcpServerName = "dep-registry"): string[] {
  return [
    "Read", "Glob", "Grep",
    `mcp__${mcpServerName}__inspectWorkflow`,
    `mcp__${mcpServerName}__submitVerificationAnalysis`,
  ];
}
