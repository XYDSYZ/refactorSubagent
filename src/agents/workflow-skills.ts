import { join, resolve } from "node:path";

/** Shared by SDK plugin loading and the skill pointers given to every writer/scout. */
export const TOOL_PLUGIN_DIR = resolve(import.meta.dir, "..", "..", ".claude", "plugins", "workflow-spec");

type WorkflowSkillName = "workflow-spec" | "verification-scout";

export function workflowSkillPath(name: WorkflowSkillName): string {
  return join(TOOL_PLUGIN_DIR, "skills", name, "SKILL.md");
}

export function workflowSkillContext(name: WorkflowSkillName): string {
  const entry = workflowSkillPath(name).split("\\").join("/");
  return `Host-provided skill: workflow-spec:${name}
Skill file (absolute): ${entry}
Read this exact file and resolve its relative document references from its directory.
This host-loaded plugin is the authoritative source of workflow guidance. If the
file cannot be read, report that path as a blocker instead of searching for another copy.`;
}
