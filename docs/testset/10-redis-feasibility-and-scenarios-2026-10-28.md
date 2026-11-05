# Redis 全流程评测：可行性与场景设计

日期：2026-10-28。结论：可以采用 Redis 作为第二个真实项目，先在 Linux/WSL 上实施。
本轮完成源码检出、一手资料核对、真实构建与定向执行，以及现有宿主的两项接入实验；
尚未新增正式 Redis case，也未调用模型编写测试、执行重构或评分。

## 1. 固定材料与实测范围

官方仓库：<https://github.com/redis/redis>。
使用 `git ls-remote --tags --sort=-v:refname` 选择正式版本标签 `8.10.3`，
并固定提交 `1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f`。
GitHub 匿名 release API 被限流，没有以其确认 latest release 元数据。

- Windows 源码检出：`runs/redis-feasibility-20261028/redis/`，浅克隆，不进入版本。
- Linux 实跑检出：`/home/yu/.cache/refactorsa-research/redis-20261028-hija9adj/redis`。
- 实跑环境：WSL Ubuntu 24.04、GCC 13.3.0、Make 4.3、Bun 1.3.14、Tcl 8.6.14。
- Tcl 通过 Ubuntu 的 `apt-get download` 获取 `tcl8.6` / `libtcl8.6`，
  用 `dpkg-deb -x` 解包到本次调查的 `tools/`，未安装系统包。包文件与校验值留在证据目录。

Redis README 列出 Linux、macOS 与 BSD 支持；本轮不使用 Windows/MinGW 构建官方 Redis。
正式评测应让 Agent 宿主、Git worktree、编译器、Redis 和测试均运行于同一个 Linux/WSL 环境，
避免 Windows 宿主误把 Linux 产物路径拼成 `.exe`。
依据：[固定版本 README](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/README.md#L308)。

## 2. 已经获得的真实结果

### 2.1 构建与上游测试

实跑命令：

```sh
make -C src -j4 MALLOC=libc USE_SYSTEMD=no OPTIMIZATION=-O2 \
  REDIS_CFLAGS=-DREDIS_TEST BUILD_TLS=no redis-server redis-cli
src/redis-server test sds
src/redis-server test dict
src/redis-server test listpack
bash ./runtest --single unit/type/string --clients 1 --timeout 120 \
  --baseport 24111 --portcount 128 --no-latency --tags '-slow'
bash ./runtest --single unit/protocol --clients 1 --timeout 120 \
  --baseport 24111 --portcount 128 --no-latency --tags '-slow'
```

| 检查 | 实际结果 | 单次墙钟时间 |
|---|---|---:|
| 核心服务器与 CLI 构建 | 成功；未克隆外部产品模块，未启用 TLS、systemd、jemalloc | 19.368 秒 |
| SDS 内部测试 | 72 passed / 0 failed | 0.022 秒 |
| dict 内部测试 | 正常退出 0，执行插入、查找、删除、冲突等测试与断言 | 0.021 秒 |
| listpack 内部测试 | 正常退出 0，执行编码、操作、校验等测试与断言 | 0.121 秒 |
| 字符串命令 Tcl 单元 | 实际出现 179 条 `[ok]`，无失败，退出 0 | 9.995 秒 |
| 协议 Tcl 单元 | 实际出现 27 条 `[ok]`，无失败，退出 0 | 5.340 秒 |
| 构建后受控源码差异 | `git diff --exit-code HEAD --` 成功，无差异 | 0.023 秒 |

这些时间不含模型调用，不是完整 Agent 的耗时预测。dict/listpack 的断言体系不累计到
`test_report()` 的统一计数，所以末尾显示 `0 total`，不能按这个数字断定没有执行。
必须结合实际测试标记、断言、执行入口和退出状态判断，不能伪造统一的用例数量。
依据：[testhelp.h](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/testhelp.h#L35)、
[dictTest](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/dict.c#L2027)、
[listpackTest](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/listpack.c#L2311)。

首次在 `/mnt/e` 下构建时，依赖扫描与文件访问耗时较长；该自有构建在 181.597 秒时主动停止，
保留日志。随后同一提交在 Linux 原生目录构建成功：一次为 23.790 秒，用户缓存目录一次为上表的
19.368 秒。路径、缓存与运行顺序不同，不据此计算严格性能比。
首次原生 `/tmp` 检出随后消失，原因未确认，后续改用上述用户缓存目录；原始成功日志仍保留。

### 2.2 现有宿主的双侧验证实验

对 Redis 真实 `src/listpack.c` 的 `lpStringToInt64` 编写一个固定 C 调用程序，
采用函数分节与链接器移除未使用代码的方式独立编译，不启动服务器、不复制实现、没有替换解析逻辑。
18 项观测包含空输入、前导零、正负号、空格、带 NUL 的显式长度输入、
有符号/无符号 64 位边界及空输出指针。

使用真实 `runStageFlow`，以预写工作流和固定补丁替换模型阶段；宿主实际创建两侧 worktree、
固定材料、分别编译运行、检查源码完整性并比较结果。

| 固定修改 | 两侧构建与运行 | 宿主裁决 | 直接证据 |
|---|---|---|---|
| 等价重命名函数局部变量 | 均成功 | `ACCEPTED`，18 项一致 | 4.119 秒 |
| 错误接受前导零 | 均成功 | `REJECTED` | `01` 原版拒绝，修改版错误接受并得到 0；3.866 秒 |
| 错误拒绝最小负整数 | 均成功 | `REJECTED` | `-9223372036854775808` 原版接受，修改版拒绝；3.616 秒 |

错误检出来自行为差异，没有编译失败、超时或崩溃冒充检出。
`verification_authoritative=true`，但 `preflight/workflows/refactor` 为实验注入，
不能称为真实 AI 全流程成功。这个函数不是公共头文件中的入口；实验固定了它当前的签名，
不能扩展为“任意 listpack 重构都应保留这个内部链接方式”。正式 listpack 场景应从适当的公开操作验证。

### 2.3 服务器生命周期与真实 AOF 实验

使用现有 `runWorkflow` 的 `process.start`、TCP 就绪、`process.run`、`wait/stop`：

1. 在独立数据目录以前台进程启动真实 Redis，绑定回环地址并 PING。
2. 观察 NX 创建、NX 拒绝覆盖、XX GET 返回旧值以及后续新值。
3. 使用长 TTL，比较本侧 `PEXPIRETIME` 在 KEEPTTL 前后是否保持，不跨侧比较墙钟时间。
4. 写入字符串和哈希，以 `appendfsync always` 记录 AOF，执行 SHUTDOWN NOSAVE。
5. 在同目录重启，读回字符串、哈希，确认 AOF manifest 存在，再正常关闭。

该工作流约 1.117 秒完成，9 项观测符合预期，两次服务器均正常退出 0，最后检查没有 Redis 进程遗留。
这是预写工作流的单侧能力实验，没有修改 Redis，没有验证 AOF 重构、损坏文件或重写过程，
也不是完整模型能力评测。

## 3. 六个正式候选场景

难度按判断、状态与运行复杂度分级，不按文件数量或代码行数评分。
任务简报只描述重构目标和行为保持要求，下面的建议、边界向量与错误补丁放在模型看不到的参考材料中。
不要求模型选择唯一方式，也不把策略名称相同作为正确性标准。

| 场景 | 重点区分的能力 | 难度 | 建议批次 |
|---|---|---|---|
| R1 字符串参数拆分 | 判断能否局部测试，识别字节与转义语义 | 低至中 | 第一批 |
| R2 SET 选项处理 | 利用现有测试，验证真实命令和错误副作用 | 中 | 第一批 |
| R3 listpack 连续修改 | 编码边界、重分配与操作序列 | 中至高 | 第二批 |
| R4 字典迁移与扫描 | 依赖回调、多阶段状态、允许的不确定性 | 高 | 第二批 |
| R5 RESP 分片与错误恢复 | 真实网络、跨请求状态与进程资源 | 高 | 第一批综合场景 |
| R6 AOF 清单与重启 | 文件格式、真实持久化、关闭与恢复 | 高 | 第二批综合场景 |

### R1：重构字符串参数拆分

目标：[sds.c 的 sdssplitargs](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/sds.c#L1066)。
可以要求整理单引号、双引号和未引用状态的控制流，保持公开接口与所有既有行为。

- **要做的事**：调查真实 SDS 和分配依赖，决定局部辅助程序或复用产物；检查分词数量、
  每个词的长度与字节、错误返回，以及释放方式。
- **关键输入**：空白与空输入、空引号、单/双引号、反斜线转义、`\x00`、`\xFF`、
  引号不闭合、闭合引号后直接跟非空白字符。用 `sdslen` 观察二进制结果，不能只用 `strlen`。
- **区分点**：简单正常字符串会让很多错误实现通过；模型还要看出“源码能局部测试”与
  “分配器完全无依赖”不同，不能顺手改写 SDS 分配头文件。
- **错误对照**：把带 NUL 的 token 当 C 字符串截断；把未闭合引号当成功；空引号被丢弃。
- **当前证据**：SDS 上游测试入口可运行；尚未实现这个任务专用的独立链接方案和错误对照。

### R2：重构 SET 系列选项判断

目标：[parseExtendedStringArgumentsOrReply](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/t_string.c#L301)，
或限定范围内的 [setGenericCommand](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/t_string.c#L87)。
首个任务只选其中一块控制流，不同时重写整个字符串命令模块。

- **要做的事**：追踪已经存在的 `unit/type/string` 测试，选择相关项，再补有实质价值的组合。
  通过真实 Redis 命令验证，不为 server/client/db 等复杂对象制作一套模拟实现。
- **关键序列**：键不存在/存在时 NX 和 XX；GET 返回旧值；失败后原值与 TTL 保持；
  KEEPTTL；非法选项组合；有旧的非字符串值时的错误行为；最新版本条件选项的相关覆盖。
- **区分点**：不能只看命令响应，还要再读键和值；不能只测试选项单独出现，而漏掉组合及错误优先级。
  TTL 使用稳定关系或本侧绝对到期时间的保持性，避免精确比较两侧剩余毫秒。
- **错误对照**：NX 失败仍覆盖数据；GET 返回新值；无条件移除 TTL；错误参数先写后报错。
- **当前证据**：179 条上游测试通过；现有宿主的服务器实验验证了部分上述操作。
  还没有运行该任务的真实模型或变异补丁。

### R3：重构 listpack 插入/替换/删除的公共准备逻辑

目标：[lpInsert](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/listpack.c#L1032)
及其公开包装，任务限制为提取重复准备逻辑、整理分支，保持编码和接口。

- **要做的事**：通过真实 listpack API 建立、插入、替换、删除、再次插入；同时检查正向和反向遍历、
  数量、内容及完整性。可以组合上游测试和局部辅助程序。
- **关键边界**：63/64、4095/4096 字节字符串，整数编码的正负边界，空值与 NUL；
  替换为更大/更小内容、删除首尾和唯一元素。反向长度编码的边界应按元素总编码长度推导。
- **区分点**：只检查最终列表会漏掉中间损坏；只正向读取会漏掉反向长度错误。
  扩容后必须用返回的新指针和正确的元素位置，测试本身不能解引用失效指针。
- **错误对照**：增长后仍用旧偏移；反向长度少一个字节；替换/删除后数量错误；将非规范数字字符串整数化。
- **当前证据**：上游 listpack 测试和局部整数解析的宿主差分实验通过；
  `lpInsert` 操作序列的专用方案尚未落地。

### R4：重构字典迁移过程中的查找与插入

目标：[dictFindLinkForInsert](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/dict.c#L1748)，
观察范围包含 [dictRehash](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/dict.c#L406)
和 [dictScan](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/dict.c#L1445)。

- **要做的事**：在尚未扩容、正在迁移、迁移完成三个状态查找/插入/删除；
  通过现有 dictType 回调制造稳定冲突并记录释放，保留真实字典逻辑和时钟依赖。
- **关键序列**：迁移中查旧键、重复键、删除碰撞链成员，替换值的所有权与释放，
  扫描过程中表扩容。明确维持哪些键始终存在，再检查这些键没有被漏掉。
- **区分点**：迁移时可能同时存在两张表；一次“插入后立刻查找”不够。
  SCAN 合法地可能重复返回元素，不能要求每个键恰好一次，也不能比较随机顺序、游标或耗时。
- **错误对照**：迁移时只查新表或旧表；重复键被重新插入；碰撞链删除断链；扫描漏掉持续存在的键。
- **当前证据**：上游 dict 测试可运行；尚未实现强制进入这些状态的专用测试。

### R5：重构 RESP 请求解析的长度/状态处理

目标：[networking.c 的 processMultibulkBuffer](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/networking.c#L3278)
中的一块长度或状态分支。通过公开网络边界观测，不能把内部 parser 复制进辅助程序替代服务器。

- **要做的事**：复用 `unit/protocol` 的真实覆盖，再用原始 socket 辅助程序补分片、流水线和错误路径。
  同一连接连续发送不同请求，并用另一个连接确认服务器仍健康。
- **关键序列**：头部/数据/CRLF 被分开送入、多个请求一次写入、零长度及带 NUL 参数、
  非法长度和溢出、错误帧后的连接关闭及新连接恢复。
- **区分点**：一次 `send` 不对应一次服务端读取，TCP 会合并数据。需要用可观察的缓冲状态或可靠同步
  确认服务器已处理不完整输入，再送剩余部分；固定 sleep 不能证明分片路径被覆盖。
  还要同时防止“错误客户端断开”变成“整个服务器崩溃”。
- **错误对照**：把不完整输入提前执行；忽略长度中的尾部垃圾；前一个请求的参数残留到下一个请求；
  错误帧后继续错位解释数据。
- **当前证据**：上游 27 条协议测试通过，宿主可管理真实服务器。
  原始 socket 辅助程序和状态同步仍待实现。

### R6：重构 AOF 清单序列化与加载辅助逻辑

目标：[aofInfoFormat / getAofManifestAsString](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/aof.c#L119)
或 [aofLoadManifestFromFile](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/aof.c#L266)。
首个任务只选格式化或加载的一块，不同时重构恢复和复制机制。

- **要做的事**：通过真实文件保存、正常关闭、重新启动验证恢复；
  为清单格式边界增加小型固定材料，复用适用的上游 AOF 测试。
- **关键序列**：普通/需转义文件名，BASE/INCR 与顺序，多份增量文件，空/损坏清单的明确错误；
  恢复后比较类型、值和必要的 TTL 关系，而非只比较“启动成功”。
- **区分点**：只在内存中读回数据证明不了持久化；必须确实退出并重启。
  新增进程、数据目录、文件生命周期和错误路径都要闭合。
  对任务承诺的清单文本格式可以逐字检查；对带动态元数据的整份 AOF/RDB 不随意固定字节。
- **错误对照**：漏序号/文件类型、错误转义、反转增量文件顺序、漏掉后一次修改；
  必须检查恢复后的结果或预期加载错误，不能拿任意启动失败当检出。
- **当前证据**：单侧写入、关闭、AOF 重启恢复通过；未跑完整 `integration/aof`，
  未验证重写、损坏文件和该任务的模型行为。

**结构性变体**：基础版本稳定后，再给 R1 或 R2 增加“提取到新 C 文件并维护构建”的任务。
它检验模型生成的构建是否适应合法拆分，而不只是给同一函数多堆输入。
先核对可信参考补丁可构建，再运行模型；不能让固定 `src/foo.c` 的局部编译方案误拒绝所有拆分。

## 4. 如何证明完整能力

每个场景复用同一份源码和任务，分三个方向运行，避免一次全流程失败却不知道问题在哪：

1. **测试编写能力**：模型只见原始工程和任务，写完后固定测试与辅助材料。
   先检查一个非平凡的等价补丁，再检查至少两个围绕本例重点的错误补丁；不让它见错后改弱测试。
2. **重构能力**：固定可信构建/测试，让重构模型修改源码，检查行为以及是否完成任务所要求的结构变化。
   注释修改、空补丁或绕过目标不能代表完成任务；不以行数或文件数评价质量。
3. **完整链路**：使用 AI 编写工作流与 AI 重构，宿主真实执行两侧验证。
   再在模型会话结束后运行独立可信检查，避免生成测试漏测而造成假接受。

当前 runner 可以配置前两种阶段替换和第三种 AI 流程，但不会自动替所有 AI 工作流执行隐藏检查。
`inject` 只分发文件，本身不执行它们；正式 Redis 评测仍需在评测侧增加一个明确的独立检查入口，
或在保存的候选补丁上另外运行固定可信工作流。原始 Agent 裁决与独立检查结果要分别保存。

主要报告这些结果：等价补丁误拒绝率、指定错误检出情况、失败的具体语义、测试方案覆盖、
是否测试了当前侧真实实现、源码/材料完整性、运行与回收，以及模型耗时/工具调用/用量。
模型评分可以辅助复核依据与缺口，不能替代真实行为检查；不因报告长、测试多而加分。
编译失败、零测试、超时、连接到旧实例和基线失败要单列，不能当作成功发现错误。

## 5. 正式接入需要处理的具体事项

- **平台与材料**：首批 case 声明 Linux，固定 Redis tag+commit；使用现有通用 `cloneSource`
  读新的 `sources/redis.json`，无需套用 `libuv-ninja-debug` 配方。macOS 后续单独验证。
- **构建范围**：8.10.3 顶层 `make` 会构建已克隆产品模块；核心显式用 `make build redis`，
  窄场景可用本轮 `make -C src ...`。不为测试核心而引入模块、TLS 或额外 SDK。
  依据：[Makefile](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/Makefile#L107)。
- **产物路径**：本项目正式 TestWorkflow 只直接启动 `build/**` 下的工作区产物，
  不能直接传 `program: "src/redis-server"`。构建应将当前侧实际产物放到 `build/verification/`，
  或使用 Make 的输出名称参数；运行上游 Tcl 可通过已测的 `bash` 执行 `./runtest`。
  本轮服务器实验是将刚构建的本侧产物复制到该目录，不是从另一侧借用二进制。
  依据：本项目 `src/runtime/workflow-pipeline.ts:441`、`src/workflow/capabilities.ts:584`。
- **工具发现**：宿主当前发现 make/bash/gcc，但不发现 tclsh/python3；
  直接启动未测量的解释器会被拒绝。正式用例需在准备阶段确认 Tcl；若直接采用解释器驱动，再补通用工具发现。
- **构建完整性**：Redis Make 可能重生成已跟踪的命令表/头文件，本次实跑未产生字节差异，
  但每侧仍要保留原有完整性检查，不能为了构建通过把保护范围排除掉。
  依据：[生成规则](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/src/Makefile#L499)。
- **上游测试筛选**：使用 `--single`、`--only` 或 `--tags`；没有 `--test`。
  零匹配时可能仍退出 0，必须要求预期测试名真实出现并成功。
  依据：[参数](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/tests/test_helper.tcl#L566)、
  [筛选](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/tests/support/test.tcl#L232)、
  [结束判定](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/tests/test_helper.tcl#L504)。
- **结果稳定性**：只比较稳定的返回值、字节、内容集合与状态关系，保留精确协议语义；
  排除日志时间、PID、端口、性能统计，不用简单“删除所有数字”的归一化。
- **资源**：服务器保持前台，明确就绪、业务握手、正常退出和异常回收；
  每例/每侧独立数据目录，首批串行，跨例并发后再分配端口区间。
  Tcl 还使用调度端口和预留 cluster bus 端口，不能只避开 6379。
  依据：[上游调度](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/tests/test_helper.tcl#L278)、
  [端口选择](https://github.com/redis/redis/blob/1a2574ce1551d3de6e0b4a56756c0fdbc6659e4f/tests/support/util.tcl#L540)。
- **失败修复**：当前真实编译/执行失败不会自动回传模型。首批如遇这类问题需保留初次结果，
  单独记录人工修复或新一轮运行，不能将其描述为模型首次成功。

第一批推荐 **R1、R2、R5**：分别代表局部代码、复用既有服务器测试、网络综合场景。
第二批再加 R3、R4、R6，用于内存状态、依赖回调和持久化。
因此无需先重写生产架构即可开始，但六个正式场景及独立可信检查仍需开发，不能视作已经入库。

## 6. 证据索引

本地忽略目录 `runs/redis-feasibility-20261028/`：

- `primary-sources.md`：research 子任务对固定官方源码的逐项核对。
- `native-baseline-results.json`、`native-*.log`：首次 Linux 原生目录成功结果。
- `cache-baseline-results.json`、`cache-*.log`：持久缓存目录的构建、内部测试与干净差异结果。
- `tcl-results.json`、`tcl-unit-*.log`：上游筛选参数、实际通过项及日志。
- `pipeline-probe.ts`、`pipeline-results.json`、`pipeline-evidence/`：局部 C 辅助程序、三份补丁与真实宿主证据。
- `service-probe.ts`、`service-workflow.ts`、`service-result.json`：服务器/AOF 生命周期实验。
- `run-baseline.py`、`run-tcl.py`、`prepare-linux.py`、`prepare-tcl.py`、`tools/`：调查脚本与 Tcl 依赖。
- `build.log`、`baseline-results.json`：主动停止的 Windows 挂载目录构建，未记为构建成功。

上述接入实验未调用真实模型或评分模型。源码、正式 case、工作流资源和生产执行逻辑没有在本轮扩展。
