# M5-P1 图片处理选型试验

仅用于 S2 选型；不进入生产构建，不提供网络入口，不访问真实用户图片。正式处理器由 S3 按确定的契约另行实现。

## 样本

使用 Pillow 12.3.0（本机已有运行时）执行 `python3 spikes/m5-image-processing/generate-fixtures.py`。生成器不读外部图片，固定随机种子和 ICC 日期；样本字节不提交，`fixtures/manifest.json` 随源码提交。每份样本的大小、摘要与独立解码预期都在 manifest；原件另存主目录 `.codex/handoffs/m5-p1-20261018/s2/`。

`node --test spikes/m5-image-processing/audit.test.mjs` 校验样本审核器。运行试验之前必须调用 `auditFixtures` 检查真实文件，不以 manifest 声明代替实际字节。正常样本预期由 Pillow 完整解码生成：方向、RGBA 取样、帧内容/时延；处理输出再独立检查。生成器/库版本不同导致摘要改变时必须显式记录新一轮，不覆盖旧证据。

## 候选依赖

候选 Sharp 0.35.5 安装在外部专用 `s2/candidate-runtime`，精确版本、`minimumReleaseAge: 4320`、`trustPolicy: no-downgrade`、`--ignore-scripts`。生产 package 与锁文件保持不变。预编译原生包和许可证的真实内容纳入选型，不能把试验可用等同生产许可已放行。

正常小样本先在 macOS 运行，边界和压力样本在512MiB容器中串行运行。完整命令、逐轮结果与来源版本见本 Phase 的 S2 报告及外部证据。任何失败、超时或子进程被结束都保留；调小预算后重测不覆盖原失败。
