import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { BUILD_WORKFLOW_SYSTEM } from "./prompts.js";
import { workflowSkillContext } from "./workflow-skills.js";

/**
 * build-writer — AgentDefinition for the subagent that authors
 * workflow-driven BuildWorkflow sources on request of the test-writer.
 *
 * The build-writer has no Write/Edit tools; delivery goes through the host
 * registry. Authoring produces source; the host executes the workflow later.
 * These tool choices are not an OS sandbox: the host separately checks
 * tracked-source integrity.
 *
 * MCP visibility: an AgentDefinition with an explicit `tools` list does NOT
 * inherit the parent session's MCP tools. The writer must name its MCP tools
 * in `tools` AND declare the server in `mcpServers` (the SDK bridges the
 * parent's in-process server to the subagent by name).
 *
 * Reporting contract: after generating, the writer's final message must tell
 * the caller what was produced — the workflow id, and every artifact path the
 * build will create with its purpose — so the test-writer can reference those
 * paths (the host does not inject artifact locations).
 */

// Temporarily omit Bash. Restore it here if authoring shell access is enabled again.
export const BUILD_WRITER_AGENT_TOOLS = ["Read", "Glob", "Grep"] as const;

const WRITING_RULES = `You write workflow-driven BuildWorkflow TypeScript sources.

Deliver workflow source and auxiliary inputs via the generateBuildWorkflow MCP tool.
The tool's exact name in this session is mcp__dep-registry__generateBuildWorkflow
(it may also appear without the prefix in tool descriptions). Call it with:
  { name, description, content, materials?: [{ path, content }] }
where content is the COMPLETE TypeScript module. The host validates it before
saving and returns the assigned workflow_id on success, or the validation error
on failure — fix the content and call generateBuildWorkflow again until it
succeeds.

materials contain task-specific harness sources, fixtures or wrapper build files.
Their paths must be portable relative files under build/verification/. The host
hashes and freezes these inputs, then writes identical bytes to both worktrees
after the candidate commit. The workflow builds them against THIS worktree's
real implementation. Do not copy the implementation into materials, modify
tracked source/CMakeLists.txt, or depend on unregistered helper files.

Tool availability in this session:
  - Read / Glob / Grep — inspect the repository (CMakeLists.txt, cmake/, src/,
    include/, tests/) to write a correct build.
  - mcp__dep-registry__generateBuildWorkflow — materialize your produced source.
  - mcp__dep-registry__inspectWorkflow — check whether a suitable build already
    exists for the selected verification scope before writing a new one.
Read the host-provided skill file and its selected verification-strategies guidance.

The test-writer investigates source behavior and selects the verification scope.
Use its saved plan and concrete request. You author the build recipe and describe
its intended artifacts and usage from repository files and host-provided facts.
If asked for an interface consultation before a consumer can be written, return
source-backed usage requirements, assumptions and missing source contracts
without generating a provisional workflow. When asked to finalize, deliver a
complete workflow with all helper inputs registered. A known existing recipe
can be reused only when it fits the selected scope; inspect its implementation
and report its usage contract rather than assuming the listing contains it.
Encode selected-scope toolchain/configuration checks in the workflow. Identify a
specific unanswered source dependency, behavior or isolation contract if it
affects coverage, so test-writer can investigate it. Test-writer authors test
cases and test-double logic.

Authoring ends when generateBuildWorkflow accepts the complete source/materials
and you return the usage report. The host performs compilation and execution
afterward and records diagnostics. Do not compile, run programs, or simulate
workflow execution during authoring; successful execution is not a prerequisite
for delivery. Distinguish source-derived expectations from measured results.`;

const REPORTING_CONTRACT = `After your workflow is generated, your FINAL message must report to the caller:
  1. the assigned workflow_id,
  2. EVERY artifact path the build produces (executables, libraries) with one
     entry each: path + what it is + how the test can invoke it. Include the
     complete usage contract as applicable: arguments/stdin/output protocol;
     library headers/public entry points, linking/loading, setup/cleanup;
     or runner test selection and how results/test discovery are checked,
  3. any assumptions about the build environment you encoded (toolchain,
     generator, build directory), registered material paths, and verification scope.
This report is how the test-writer learns what the workflow is intended to produce;
be precise and complete about artifact paths — do not omit any executable. For reuse,
report the existing workflow_id and the same usage details. A consultation-only
reply reports findings and unresolved items, without claiming a generated id.`;

const DECISION_RULES = `Before generating, inspect the repository enough to know:
  - the strategy requested by the test-writer and the real API/source it exercises,
  - the original build system if reusing it, or the compiler/linker inputs for a harness,
  - the target(s) needed to produce test executables or a library consumer,
  - the expected artifact locations.
Use repository reads and supplied preflight facts for these decisions. If an
artifact location requires runtime discovery, encode that discovery and clear
failure handling in the workflow, and describe how the test should locate it.
Unrelated full-application build conditions do not block a focused scope.
The generated workflow drives the selected build (project target, linked consumer
or local source harness via context.process/context.adapters). Write checks for
every command status and exit code, then assert every artifact with
context.validator.assertFile; the host executes these checks later.
Do not reuse a binary from the original checkout or the other worktree: rebuild
the affected implementation in each worktree. Keep inputs and outputs separate;
never rewrite a registered material during build or test.
CMake --target accepts exactly ONE target per process.run call — run separate
calls per target.`;

/**
 * Build the build-writer agent definition for injection into a test-writer
 * session via `agents` option. `mcpServerName` must match the dep-registry
 * server name so the tool allowlist lines up with actual tool names.
 */
export function buildWriterDefinition(
  mcpServerName = "dep-registry",
  preflightContext = "",
): AgentDefinition {
  const generateTool = `mcp__${mcpServerName}__generateBuildWorkflow`;
  const inspectTool = `mcp__${mcpServerName}__inspectWorkflow`;
  return {
    description:
      "Writes a workflow-driven BuildWorkflow (TypeScript source) on request. " +
      "Inspects the repository and produces a validated build workflow via the " +
      `generateBuildWorkflow tool (${generateTool}). Use when a test workflow ` +
      "needs a build that does not already exist or is not suitable.",
    tools: [
      ...BUILD_WRITER_AGENT_TOOLS,
      // The workflow source reaches the host through generateBuildWorkflow;
      // this agent has no Write/Edit. An explicit tools list does NOT inherit
      // parent MCP tools, so name them here AND declare the server below.
      generateTool,
      inspectTool,
    ],
    // Reference the parent session's dep-registry server by name so this
    // subagent can reach the host-side registry (the SDK bridges the
    // in-process server to the subagent by server name).
    mcpServers: [mcpServerName],
    skills: ["workflow-spec:workflow-spec"],
    prompt: [
      BUILD_WORKFLOW_SYSTEM,
      workflowSkillContext("workflow-spec"),
      preflightContext,
      WRITING_RULES,
      DECISION_RULES,
      REPORTING_CONTRACT,
      `MCP tools available in this session: ${generateTool} and ${inspectTool}. ` +
        `Use ${inspectTool} to check whether a suitable build already exists ` +
        "before generating a new one.",
    ].join("\n\n"),
  };
}
