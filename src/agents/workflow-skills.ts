import { join, resolve } from "node:path";

/** Shared by SDK plugin loading, authoring sessions, and investigation evaluation. */
export const TOOL_PLUGIN_DIR = resolve(import.meta.dir, "..", "..", ".claude", "plugins", "workflow-spec");

/** C refactoring techniques plugin — referenced by name from the refactor session. */
export const C_REFACTOR_PLUGIN_DIR = resolve(import.meta.dir, "..", "..", ".claude", "plugins", "c-refactor");

/** Plugin directories every agent session loads; per-session `skills` filters visibility. */
export function sessionPluginDirs(): { type: "local"; path: string }[] {
  return [
    { type: "local", path: TOOL_PLUGIN_DIR },
    { type: "local", path: C_REFACTOR_PLUGIN_DIR },
  ];
}

type WorkflowSkillName = "workflow-spec" | "verification-planning";

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

/**
 * Force-read context for the C refactoring techniques skill. The SDK's
 * `skills`/`plugins` options proved inert under the pinned SDK build (a live
 * probe saw zero skills, including the production workflow-spec ones), so —
 * exactly like the test-writer's workflow-spec guidance — the refactor
 * session receives the SKILL.md absolute path in its prompt and must read
 * that exact file.
 */
export function cRefactorSkillContext(): string {
  const entry = join(C_REFACTOR_PLUGIN_DIR, "skills", "c-refactor-techniques", "SKILL.md").split("\\").join("/");
  return `Host-provided skill: c-refactor:c-refactor-techniques
Skill file (absolute): ${entry}
Read this exact file before editing any C file, and resolve its relative document
references from its directory. This host-loaded skill is the authoritative source
of behavior-preserving C refactoring technique guidance. If the file cannot be
read, report that path as a blocker instead of searching for another copy.`;
}
