# 错误路径

每条格式：**模式 → 危险（通道）→ 行为保持的改写 → 反例**。
"通道"指验证系统对比的 observable channel：exit code / signals / stdout / stderr / filesystem。

## 1. errno 是可观察状态：库调用会悄悄改它

**模式**：`errno` 在失败后被读出/打印/转成字符串（`perror`、`strerror`）；
函数中途穿插了别的库调用（malloc、printf）。

**危险（通道）**：printf/malloc 可能覆写 errno → 原代码若在错误分支里先输出
再处理，穿插顺序错一行 → **stderr 内容漂移**。

**行为保持的改写**：
- 保持原代码"读 errno 前执行了哪些调用"的顺序——哪怕它看起来浪费；
- 不"顺手"把 `errno` 的读取提前/推后，不把 `perror` 换成 `fprintf(stderr, strerror(...))`
  （输出格式不同：perror 带 `: ` 与换行约定）→ **stderr 字节级对比会抓到**；
- 提取辅助函数时 errno 的保存/恢复（`int saved = errno;`）原样带走。

## 2. 返回码是契约：负数、零、特定 errno 值各归其位

**模式**：`return -1;` / `return -ENOMEM;` / `return 0;` 的分布、
调用方按值分派（`if (ret < 0)` vs `if (ret == -1)` vs `switch (ret)`）。

**危险（通道）**：错误码语义变了，调用方分支走向变 → **exit code / stdout 漂移**；
-ENOMEM 与 -1 的差别在打印时可见 → **stderr 漂移**。

**行为保持的改写**：
- 提取/内联函数时，错误码的**值域与判断方向**逐条照抄；
- 合并两个相似的错误分支前先确认调用方对这两个值的处理是否真的相同——
  不同就不合并；
- 不"统一"错误码风格（-1 → -errno 是行为变更，不是重构）。

## 3. 失败路径上的部分输出：写了一半也是行为

**模式**：循环里边处理边输出，第 k 项失败退出——前 k-1 项的输出已经在
stdout/文件里。

**危险（通道）**：改写把"先整体校验再输出"或"输出攒起来最后一次性写"都会
改变**失败时已落盘的字节** → **stdout / 文件内容漂移**（两侧失败点不同时
对比直接 REJECTED；两侧同点失败但字节不同也 REJECTED）。

**行为保持的改写**：
- 输出调用的位置、次数、顺序保持逐条对应；
- 缓冲策略不改（见第 5 条缓冲 flushing）；校验提前只能作为**新增守卫**加在
  输出之前，且必须证明对合法输入不可见。

**反例**：
```c
/* 坏：把循环内 fprintf 挪到循环后"一次性输出"——
   输入第 3 项失败时，旧代码 stdout 有两行，新代码一行都没有 */
```

## 4. 清理函数的返回值与副作用：fclose/free 不是无操作

**模式**：`fclose(fp)` 的返回值被检查/忽略、`close(fd)` 失败分支、
`free(NULL)` 的合法性依赖。

**危险（通道）**：fclose 失败（缓冲未刷盘）路径若原代码有 stderr 输出或
退出码分支，改写漏掉 → **exit code / stderr 漂移**；把 `fclose` 换成
`close(fileno(fp))` 会双重关闭 → **signals（SIGABRT/SIGSEGV 风险）**。

**行为保持的改写**：
- 清理调用的**个数、顺序、返回值检查**逐条保持；
- 不更换资源 API 族（fopen↔open、fclose↔close 是不同的缓冲与失败语义）；
- `free(NULL)` 是合法 no-op——原代码若依赖这一点省了 if，别"补上"判断
  （行为相同但代码路径不同没关系；关键是别把没有的判断删掉）。

## 5. 退出方式决定缓冲是否冲洗：exit / return / _exit / abort

**模式**：`exit(code)` 与 `return code`（都冲洗 stdio 缓冲）vs `_exit(code)`、
`abort()`、`exit` 在信号处理器里（未定义）。

**危险（通道）**：改写把末尾的 `return code` 改成 `exit(code)` 大多数情况等价，
但把冲洗类退出改成 `_exit`/`abort` → 缓冲内容丢失 → **stdout/文件内容漂移**、
**signals 漂移（abort → SIGABRT，exit code 完全不同）**。

**行为保持的改写**：
- 退出方式逐点保持：exit 就 exit，return 就 return，abort 就是 abort——
  它们是三个不同的可观察事件（exit code 不同：abort 在 Windows/Linux 上
  产生不同的终止码与信号）；
- stdout 的缓冲模式（终端行缓冲 / 重定向全缓冲）意味着**输出与失败交错的
  顺序**在重定向场景下也可能可见——保持输出语句与失败路径的相对顺序。
