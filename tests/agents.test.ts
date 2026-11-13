import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson, sdkToolsOf } from "../src/agents/driver.js";
import { REFACTOR_AGENT_TOOLS, REFACTOR_SKILLS } from "../src/agents/refactor.js";
import { TEST_WRITER_AGENT_TOOLS } from "../src/agents/workflow-session.js";
import { C_REFACTOR_PLUGIN_DIR, TOOL_PLUGIN_DIR, cRefactorSkillContext, sessionPluginDirs } from "../src/agents/workflow-skills.js";
import { refactorPrompt } from "../src/agents/prompts.js";

describe("extractJson", () => {
  test("parses fenced json block", () => {
    const out = extractJson('intro\n```json\n{"a": 1}\n```\ntrailer');
    expect(out).toEqual({ a: 1 });
  });

  test("parses bare json object", () => {
    expect(extractJson('{"b": [1,2]}')).toEqual({ b: [1, 2] });
  });

  test("throws when nothing parses", () => {
    expect(() => extractJson("no json here")).toThrow();
  });

  test("prefers fenced block over surrounding text", () => {
    const out = extractJson('{"wrong": true}\n```json\n{"right": false}\n```');
    expect(out).toEqual({ right: false });
  });
});

describe("session tool boundaries", () => {
  test("refactor session grants file tools + a shell, and nothing else", () => {
    // The allowlist IS the boundary (no host-side scope hook any more), so the
    // exact set matters: adding a tool here silently widens what the model can do.
    expect([...REFACTOR_AGENT_TOOLS].sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
  });

  test("test-writer currently grants file tools and Task for the build-writer", () => {
    expect([...TEST_WRITER_AGENT_TOOLS].sort()).toEqual([
      "Edit", "Glob", "Grep", "Read", "Task", "Write",
    ]);
  });
});

describe("sdkToolsOf — the Skill tool visibility contract", () => {
  test("naming skills restores the Skill tool into the strict --tools set", () => {
    // Without this the CLI's --tools replacement drops the Skill tool and
    // hides every plugin skill (verified live: claude.exe 2.1.259).
    expect(sdkToolsOf(["Read", "Bash"], ["c-refactor:c-refactor-techniques"]))
      .toEqual(["Read", "Bash", "Skill"]);
  });

  test("no skills named: the tool set passes through untouched", () => {
    expect(sdkToolsOf(["Read"], undefined)).toEqual(["Read"]);
    expect(sdkToolsOf(["Read"], [])).toEqual(["Read"]);
  });

  test("Skill already present: no duplicate", () => {
    expect(sdkToolsOf(["Read", "Skill"], ["workflow-spec:workflow-spec"]))
      .toEqual(["Read", "Skill"]);
  });
});

describe("c-refactor-techniques skill wiring", () => {
  const SKILL_DIR = join(C_REFACTOR_PLUGIN_DIR, "skills", "c-refactor-techniques");

  test("the refactor session sees exactly the techniques skill", () => {
    // Knowledge injection only: a wrong name here either leaks the skill to no
    // session or silently loads nothing — the exact set matters.
    expect([...REFACTOR_SKILLS]).toEqual(["c-refactor:c-refactor-techniques"]);
  });

  test("both plugin directories are registered for sessions", () => {
    const dirs = sessionPluginDirs();
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toEqual({ type: "local", path: TOOL_PLUGIN_DIR });
    expect(dirs[1]).toEqual({ type: "local", path: C_REFACTOR_PLUGIN_DIR });
    for (const dir of dirs) expect(existsSync(dir.path)).toBe(true);
  });

  test("the skill entry exists with host-forced frontmatter", () => {
    const entry = join(SKILL_DIR, "SKILL.md");
    expect(existsSync(entry)).toBe(true);
    const text = readFileSync(entry, "utf8");
    expect(text).toContain("name: c-refactor-techniques");
    expect(text).toContain("user-invocable: false");
  });

  test("every indexed topic document exists", () => {
    // Technique docs use the four-part format; self-check is a checklist and
    // only needs the channel framing.
    const techniqueDocs = [
      "integer-and-overflow",
      "pointers-and-aliasing",
      "control-flow-equivalence",
      "error-paths",
      "macros",
      "static-state",
    ];
    for (const topic of [...techniqueDocs, "self-check"]) {
      const path = join(SKILL_DIR, `${topic}.md`);
      expect(existsSync(path)).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("通道");
      if (techniqueDocs.includes(topic)) {
        expect(text).toContain("危险");
        expect(text).toContain("反例");
      }
    }
  });

  test("the force-read context points at the real SKILL.md and lands in the prompt", () => {
    // The SDK skills/plugins options are inert under the pinned SDK build, so
    // the prompt-embedded absolute path IS the injection mechanism: it must
    // name the exact on-disk file, mirror the workflow-spec wording, and be
    // carried by refactorPrompt.
    const context = cRefactorSkillContext();
    expect(context).toContain("c-refactor:c-refactor-techniques");
    expect(context).toContain(join(C_REFACTOR_PLUGIN_DIR, "skills", "c-refactor-techniques", "SKILL.md").split("\\").join("/"));
    expect(context).toContain("Read this exact file");
    const prompt = refactorPrompt("重构任务", context);
    expect(prompt.indexOf(context)).toBe(0);
    expect(prompt).toContain("Task: 重构任务");
    // Backward compatibility: without the context the prompt is unchanged.
    expect(refactorPrompt("任务").startsWith("Task: 任务")).toBe(true);
  });
});
