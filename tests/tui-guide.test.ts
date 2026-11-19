import { describe, expect, test } from "bun:test";
import { guideSection } from "../src/cli/tui/guide.js";

/**
 * TUI 使用指引分区：裸启动（无参数进 TUI）后，第一屏就能看到
 * 任务指引（每个功能的中英对照）、参数指引（每个参数填什么）、流程说明。
 */

describe("guideSection — TUI 使用指引", () => {
  const section = guideSection();

  test("分区挂载在最前，标题与条目齐全", () => {
    expect(section.id).toBe("guide");
    expect(section.title).toContain("使用指引");
    expect(section.items()).toHaveLength(3);
    expect(section.items().map((item) => item.id)).toEqual([
      "guide-tasks",
      "guide-params",
      "guide-flow",
    ]);
  });

  test("任务指引：四大功能的中英对照齐全", async () => {
    const detail = await section.items()[0]!.detail();
    const text = detail.paragraphs.map((p) => p.text).join("\n");
    expect(text).toContain("tests prepare / tests review 命令"); // 测试文件用
    expect(text).toContain("run 命令"); // 重构文件用
    expect(text).toContain("workflow list 命令"); // 方案库
    expect(text).toContain("preflight 命令"); // 机器体检
    expect(detail.title).toContain("任务指引");
  });

  test("参数指引：每个参数的含义与示例齐全", async () => {
    const detail = await section.items()[1]!.detail();
    const text = detail.paragraphs.map((p) => p.text).join("\n");
    expect(text).toContain("仓库路径"); // 填路径
    expect(text).toContain("--task <任务描述>");
    expect(text).toContain("--auto-retry <次数>");
    expect(text).toContain("--resume <会话id>");
    expect(text).toContain("--scope <行为描述>");
    expect(text).toContain("--from <方案目录>");
  });

  test("流程说明：六阶段与反馈修复讲清楚", async () => {
    const detail = await section.items()[2]!.detail();
    const text = detail.paragraphs.map((p) => p.text).join("\n");
    expect(text).toContain("六阶段");
    expect(text).toContain("REJECTED");
    expect(text).toContain("反馈");
  });
});
