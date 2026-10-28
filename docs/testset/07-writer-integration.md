# 真实测试编写与双侧执行验证

本场景通过 `runStageFlow` 测试真实源码调查、测试编写、构建准备与宿主执行。
当前 test-writer 在同一会话内调查并编写测试，build-writer 编写构建流程；实际构建和运行由宿主完成。
两个编写角色目前暂时不开放 Bash，编写期间只交付代码与使用说明。下方带日期的记录保留当时架构。
重构阶段使用固定补丁，验证阶段使用生产实现。它与独立调查评测、预置 workflow 的执行测试分别提供证据。

合并前后真实运行、覆盖变化及已知汇总局限见
[`2026-10-28 对比报告`](08-merged-authoring-comparison-2026-10-28.md)。
随后按“编写交付、宿主执行”职责调整的单次真实结果见
[`编写期间不运行`](09-authoring-without-execution-2026-10-28.md)。

## 场景与判定

复用 `resources/scout/fixtures/local-function`：`text_copy` 是无外部依赖的局部函数，
完整应用依赖 Vulkan。给 writer 的任务只描述行为保持型重构，不预告应选的策略或错误补丁。

一次真实编写后，固定 build/test workflow 源码和辅助输入 sidecar 的 SHA-256，
记录项目基线提交并检查重放时受控源码未变，
再复用同一套验证方案测试下列补丁；不因某个错误没有被识别而补写测试。

| 补丁 | 有意改变的行为 | 期望 |
|---|---|---|
| `equivalent` | 提取长度计算辅助函数，保持公开行为 | 两侧构建与测试有效，比较一致，ACCEPTED |
| `truncated-return` | 截断时返回复制长度 | 两侧构建成功、baseline 测试有效，candidate 行为被识别 |
| `capacity-one` | capacity=1 时不写结尾 NUL | 两侧构建成功、baseline 测试有效，candidate 行为被识别 |

运行前，宿主用已有隐藏 C 判据分别编译三份实现，确认等价补丁通过、错误补丁失败。
该判据和补丁不复制进 writer 的项目目录。角色工具仍不提供 OS 文件隔离。

错误可以表现为观测比较不一致（`REJECTED`），也可以先触发消费者的行为断言，
使 candidate TestWorkflow 失败（生产状态为 `ABORTED`）。后者在汇总中单独标为
`candidate-test-failure-review-required`，需要人工检查原始输出与断言。
编译失败、baseline 失败、超时、signal、进程启动失败都不算识别成功。
汇总必须 `complete=true` 且所有控制符合预期才通过。

当前自动汇总只识别候选原生进程非零退出的断言失败。如果原生程序正常输出，
由 TypeScript 工作流检查实际输出后抛错，生产仍会中止验证，但汇总可能漏分类。
这种结果应保留原始 `ok:false`，另行复核工作流断言和实际输出；不能用正常退出码或共同失败推断行为等价。

## 命令

```powershell
# 无模型调用：验证控制补丁
bun scripts/e2e-verification-authoring.ts --controls-only --out runs/writer-controls-new

# 调用真实测试编写会话与构建子角色；随后固定复用产物测试错误补丁
bun scripts/e2e-verification-authoring.ts --out runs/writer-live-new --limit sessions.testWriter.model=sonnet

# 保留已生成方案，换一个新结果目录重新执行三个补丁，不再调用模型
bun scripts/e2e-verification-authoring.ts --replay runs/writer-live-new --out runs/writer-replay-new
```

输出目录不能覆盖已有目录。默认模型会话期限 15 分钟，每侧构建/测试各 2 分钟，
单条运行命令默认 30 秒；可通过现有 `--limit` / `--limits-file` 覆盖。
请求模型别名不证明实际后端身份，应检查保存的会话响应。

`authoring.json` 保存可复用来源及哈希；`controls.json` 保存补丁独立判据结果；
`summary.json` 保存状态、检测方式、失败原因与日志目录。
`sessions/.refactor/e2e/<control>/` 保留模型会话、两侧构建执行、测试观测、patch 与判定记录。

## 验证边界

本场景只证明选定局部函数和两个错误控制上的衔接与检测能力。
它不证明任意错误可被识别，也不替代共享库、真实依赖故障和真实重构模型的组合验证。
需要人工检查实际选用的源码、辅助代码和观测，确认运行的是各侧实现。

## Windows 实测（2026-10-26）

本轮先完成 `bun run check`：类型检查、221 pass / 0 fail（36 文件，810 个断言，289.33 秒）和执行器 self-test 均通过。
新增脚本的最终版本另经 typecheck 与固定方案复跑验证。

真实调用请求别名为 `sonnet`，主 writer、scout、build-writer 的响应均声明 `deepseek-v4.1-flash`。
因此本轮不是 Claude Sonnet 能力测评，也不是异构模型交叉验证。只调用了一次编写会话，
scout 和 build-writer 均为前台委托。没有调用裁判模型。

scout 推荐 `source-harness`；test-writer 提供 C harness，build-writer 实测编译并登记一个辅助材料，
然后 writer 提交依赖声明和 TestWorkflow。构建命令使用各侧真实 `src/text_copy.c`、`include/text_copy.h`，
没有配置 Vulkan 应用，也没有复制被测实现。原仓库受控源码保持不变。

生成的 harness 共 17 个输入场景，观测返回值、目标字节和源字节；另观测用例总数与失败数，共 53 项期望。
在保持行为的补丁上，两侧全部有效且 53 项一致，生产状态为 `ACCEPTED`。

| 控制 | 两侧构建 | baseline 测试 | candidate 测试 | 生产状态与复核 |
|---|---|---|---|---|
| `equivalent` | 成功 | 通过 | 通过 | `ACCEPTED`，53 项一致 |
| `truncated-return` | 成功 | 通过 | 行为断言失败，正常退出码 1 | `ABORTED`；容量 5、源 `hello` 时返回 4，baseline 返回 5 |
| `capacity-one` | 成功 | 通过 | 行为断言失败，正常退出码 1 | `ABORTED`；目标字节为 `aaaaaaaaaa`，baseline 为 `00aaaaaaaa` |

两份错误补丁只改变 `src/text_copy.c`。已复核生成的断言和输出，确认候选失败来自预设行为错误，
没有编译错误、超时或 signal。它们未进入观测比较，不能改记为 `REJECTED`。
没有为识别错误修改生成的测试。随后固定复用全部 workflow 和辅助输入，零模型复跑三个控制，结果相同；
两次运行的所有 authoring pins 一致。

证据保存在未入库的本地目录：

- `runs/check-20261026-win.txt`：完整工程检查。
- `runs/writer-controls-20261026-b/`：独立 C 判据确认控制补丁的性质。
- `runs/writer-live-20261026-a/`：真实编写与三份补丁结果，含 `review.json` 和 `session-metadata.json`。
- `runs/writer-replay-20261026-a/`：固定方案的无模型复跑。

仍有明确改进点：scout 和主会话搜索了不影响局部方案的 Vulkan 安装位置；
生成场景未覆盖零容量非 NULL 目标和只读源内存。此前将首个 NUL 后尾部字节列为缺口有误：
harness 实际构造了 `hello\0ZZZZ`，检查返回长度及源字节不变，该输入已覆盖。
这不影响本轮两个错误控制被识别的证据，但不能据此宣称覆盖完整。
共享库组合、真实 refactor 模型以及 Linux/macOS 仍待验证；本轮没有改生产提示词或流程。
