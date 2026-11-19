import type { Detail, Item, Section } from "./workbench.js";

/**
 * guide — TUI 界面的「使用指引」分区。
 *
 * 回答三个问题：我能让这个工具做什么（任务指引）、每个参数填什么（参数指引）、
 * 程序拿到参数之后会做什么（流程说明）。全部中文；命令示例可直接复制到终端。
 */

const COMMAND_TABLE = [
  { text: "测试文件（设计/审阅测试方案）用：tests prepare / tests review 命令", tone: "accent" as const },
  { text: "重构文件（真正修改代码）用：run 命令", tone: "accent" as const },
  { text: "查看已保存的构建方案用：workflow list 命令", tone: "accent" as const },
  { text: "检查机器是否就绪用：preflight 命令", tone: "accent" as const },
] as const;

const PARAMETER_TABLE = [
  { text: "仓库路径（--run 后第一个参数）：填本地项目的文件夹路径，例如 examples/trim-app，或绝对路径 D:\\projects\\my-c-app。", tone: "normal" as const },
  { text: "--task <任务描述>：填一句你想让 AI 做的重构内容，自由文本，例如「把 trim 函数里的重复逻辑提取成辅助函数」。", tone: "normal" as const },
  { text: "--auto-retry <次数>：验证失败后允许 AI 自动修复的最大次数（默认 3；0 关闭）。失败原因不同，接手的 AI 也不同：行为漂移找重构师、考卷出错找出卷师、构建失败找构建修理工。", tone: "normal" as const },
  { text: "--resume <会话id>：填上次中断的运行 id（本页「反馈历史」分区里可查），从断点继续而不是从头重来。", tone: "normal" as const },
  { text: "--scope <行为描述>（仅 tests prepare）：填一句被测程序应该有的行为，例如「程序编译成功并正常退出」。", tone: "normal" as const },
  { text: "--from <方案目录>（仅 tests review）：填之前保存的测试方案目录，审阅或修改它。", tone: "normal" as const },
] as const;

const FLOW_EXPLANATION = [
  { text: "你提交任务后，程序按六阶段流水线执行：① 体检机器 → ② 分析项目 → ③ 出卷（AI 写构建与测试脚本）→ ④ 准备两份代码（原版 + 改后）→ ⑤ 施工（AI 修改候选版）→ ⑥ 验证（同一考卷两侧各跑一遍，逐项对比）。" },
  { text: "第 ⑥ 步任何一条行为与原版不一致 → 判决 REJECTED。开着自动修复时，程序把失败证据喂回惹祸的 AI 对话让它修改（这就是反馈修复），然后重新验证，直到通过、额度用完或原地打转。" },
  { text: "全程只有第 ③⑤ 步使用 AI；每一步的产物都是可查验的结构化文件（本界面的各个分区就是它们的实时展示）。" },
] as const;

export function guideSection(): Section {
  const items: readonly Item[] = [
      {
        id: "guide-tasks",
        label: "任务指引 · 我能让它做什么",
        description: "每个功能的中英对照与用途",
        detail: (): Detail => ({
          title: "任务指引 —— 功能一览",
          paragraphs: [
            { text: "你想做的事 → 对应的命令", tone: "heading" },
            ...COMMAND_TABLE.map((row) => ({ text: row.text, tone: row.tone })),
            { text: "四大功能详解：", tone: "heading" },
            { text: "① run（跑全流程）：一条命令完成「AI 出卷 → 准备原版/改后两份代码 → AI 改代码 → 逐项对比验证 → 给出判决」。本界面就是它的实时展示。" },
            { text: "② tests prepare（设计测试）：不跑重构，专门为某个行为设计测试方案，保存成目录供以后审阅或直接进入重构。" },
            { text: "③ tests review（审阅测试）：打开之前保存的测试方案，检查场景、观测值和文件差异，可修改后重试。" },
            { text: "④ workflow list（方案库）：列出共享库里保存的构建方案（名字、版本、描述），供多次运行复用。" },
          ],
        }),
      },
      {
        id: "guide-params",
        label: "参数指引 · 每个参数填什么",
        description: "参数含义与示例值",
        detail: (): Detail => ({
          title: "参数指引 —— 填写对照表",
          paragraphs: [
            { text: "参数 → 含义 → 示例", tone: "heading" },
            ...PARAMETER_TABLE.map((row) => ({ text: row.text, tone: row.tone })),
            { text: "路径统一填本地文件夹或文件路径；相对路径以你敲命令时所在的目录为基准。", tone: "muted" as const },
          ],
        }),
      },
      {
        id: "guide-flow",
        label: "流程说明 · 程序会做什么",
        description: "六阶段流水线与反馈修复",
        detail: (): Detail => ({
          title: "流程说明 —— 从提交任务到最终判决",
          paragraphs: FLOW_EXPLANATION.map((row) => ({ text: row.text })),
        }),
      },
    ];
    return { id: "guide", title: "使用指引", items: () => items };
  }
