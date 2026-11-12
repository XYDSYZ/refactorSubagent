---
name: c-refactor-techniques
user-invocable: false
description: >-
  Behavior-preserving C refactoring techniques. Consult the relevant topic
  document BEFORE editing any C file: integer/pointer/control-flow/error-path/
  macro/static-state hazards, UB red lines, and the pre-finish self-check.
  Every technique is tied to one observable channel the verifier compares.
---

# C 行为保持重构技巧

你是行为保持型重构系统里的重构模块。改任何 C 代码之前，先根据目标文件的内容
查阅下方主题文档，再动手。所有技巧服务于同一个目标：

> **外部可观察行为逐通道保持**：exit code / signals / stdout / stderr / filesystem effects。
> 验证系统会在 baseline 与 candidate 两侧逐通道对比——任何一条漂移 = REJECTED。

## 硬性红线（违反 = 必然被验证拒绝，或引入未定义行为）

1. **不引入任何未定义行为**：有符号溢出、越界、解引用野指针、错误对齐、
   数据竞争、修改 const 对象。UB 不是"优化"——编译器可以假定 UB 不发生，
   开优化后整段分支可能被删除。
2. **不改变任何出现在** `if` / `return` / 比较 / 打印 / 写入中的**常量值、
   字符串字面量、格式串**。
3. **不合并或拆分会改变求值次数、求值顺序副作用、短路行为的表达式。**
4. **不替换算法**（即使"看起来等价"）——除非能对全部输入域证明逐通道等价，否则停。
5. **不碰函数签名、链接性（static ↔ extern）、头文件里的声明**——它们是
   外部契约，不是重构对象。
6. **允许且仅允许**：内部结构重组、局部变量组织、提取 `static` 辅助函数、
   删除可证不可达的死代码。

## 主题索引（按目标代码内容选读，用 Read 打开）

| 目标代码里有… | 读 |
|---|---|
| 整数算术、位运算、size_t/ssize_t/枚举、隐式转换 | integer-and-overflow.md |
| 指针运算、数组与 strlen/memcpy、字符串拼接截断、别名 | pointers-and-aliasing.md |
| 复杂条件、深嵌套循环、goto、多出口、短路求值 | control-flow-equivalence.md |
| errno、负数返回码、资源清理、多级 if-else 错误分支 | error-paths.md |
| 宏（对象宏/函数宏）、#if、token 拼接 | macros.md |
| 函数内 static、全局状态、缓冲区复用、非可重入函数 | static-state.md |

## 动手前后的自检

改完每个函数，过一遍 self-check.md：对每个可观察通道自问
"这段改动可能改变它吗"。**证明不了"逐通道等价"的部分：停下并在总结里说明，
不要猜。** 你有 Bash——先用真实编译验证语法，再结束（系统提示词里写了
构建输出该放哪）。

## 技巧的取舍标准

宁可少重构，也不要改变任何可观察行为。一个"漂亮但证明不了等价"的改写，
价值是负的：它消耗一整轮验证并产出 REJECTED。文档里每条技巧都标注了
"验证系统会用哪个通道抓它"——如果你答不上来某个改写会被哪个通道监督，
就把它当作不可证明，放弃它。
