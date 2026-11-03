# 外部通信依赖与失败回收

目标：`src/frame_client.c`。任务与协议保持要求见任务简报。

参考检查见 `resources/judge/`；固定对照如下。

- equivalent：把三段收发循环提取到新 C 文件并维护 CMake，期望 ACCEPTED。
- repeat-write-prefix：分段发送时重复首字节，期望 REJECTED。
- skip-checksum：忽略响应校验和，期望 REJECTED。
- leak-failed-connection：错误路径泄漏连接，期望 REJECTED。

复核生成方案是否调用当前侧真实实现，是否保持外部接口与资源所有权，是否有效执行而非只声明成功。测试方式无需与参考相同。实质性的辅助函数提取和任务完成度需要结合候选补丁人工或模型评分，单纯改名不能作为任务完成。

## 行为与质量复核要点

生产工程没有 DeviceSDK 二进制/硬件/测试程序；测试应自行实现公开 transport_* ABI 的替身，并链接当前侧真实 frame_fetch。
协议为请求 A5 ID、响应 5A ID 大端长度 PAYLOAD XOR，payload 0..256 且可含 NUL，公开错误码和输出所有权见工程头文件。
17 项参考覆盖部分 I/O、-2 临时不可用与重试、连接/断开/永久失败、非零时钟纪元、整个交换共享时限、校验和/ID/长度错误、容量不足、失败输出原子性和连接释放。
不能替换 frame_fetch 或复制其算法；时钟应可控，避免真实等待。应允许合理实现改变分段次数，不把确切读写次数和剩余预算序列作为公开契约。
有效固定对照会新增 src/frame_io.c/.h 并维护 CMake，因此构建方案还应容许内部跨文件拆分。
