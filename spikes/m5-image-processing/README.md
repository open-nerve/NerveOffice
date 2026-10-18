# M5-P1 图片处理选型试验

仅用于 S2 选型；不进入生产构建，不提供网络入口，不访问真实用户图片。正式处理器由 S3 按确定的契约另行实现。

## 样本

使用 Pillow 12.3.0（本机已有运行时）执行 `python3 spikes/m5-image-processing/generate-fixtures.py`。生成器不读外部图片，固定随机种子和 ICC 日期；样本字节不提交，`fixtures/manifest.json` 随源码提交。每份样本的大小、摘要与独立解码预期都在 manifest；原件另存主目录 `.codex/handoffs/m5-p1-20261018/s2/`。

`node --test spikes/m5-image-processing/audit.test.mjs` 校验样本审核器。运行试验之前必须调用 `auditFixtures` 检查真实文件，不以 manifest 声明代替实际字节。正常样本预期由 Pillow 完整解码生成：方向、RGBA 取样、帧内容/时延；处理输出再独立检查。生成器/库版本不同导致摘要改变时必须显式记录新一轮，不覆盖旧证据。

## 候选依赖

候选 Sharp 0.35.5 安装在外部专用 `s2/candidate-runtime`，精确版本、`minimumReleaseAge: 4320`、`trustPolicy: no-downgrade`、`--ignore-scripts`。生产 package 与锁文件保持不变。预编译原生包和许可证的真实内容纳入选型，不能把试验可用等同生产许可已放行。

正常小样本先在 macOS 运行，边界和压力样本在512MiB容器中串行运行。完整命令、逐轮结果与来源版本见本 Phase 的 S2 报告及外部证据。任何失败、超时或子进程被结束都保留；调小预算后重测不覆盖原失败。

## 运行与复核

`node spikes/m5-image-processing/run.mjs <候选runtime绝对路径> <新输出目录> --small --faults` 在macOS跑34个小样本与两种故障后恢复；Linux完整矩阵去掉 `--small`，加 `--address-mib=1536 --faults`，共44个样本与三种故障。Linux容器额外固定512MiB、单CPU、只读根目录、禁网、64个PID、无core dump、无额外capability。`Dockerfile` 读取含 `probe/` 和 `runtime/` 的专用构建上下文，不复制用户主目录。

运行器在开始前复制本轮源码、样本和候选锁文件；原始stdout/stderr、每例JSON、图片、cgroup与汇总一起保存。`verify-results.py <结果目录> <新回执文件>` 只读核对摘要、输入/预期、进程结果和故障后恢复，并用Pillow重新完整解码实际输出检查方向、像素、透明度、元数据、帧数、时长与循环。不能把仅有汇总的pass字段当验收。

2026-10-18 Task2证据：`mac-07` 34/34 + 2种故障，`linux-07` ARM64原生44/44 + 3种故障，`linux-amd64-01` x64仿真34/34 + 3种故障，均通过独立输出复核。x64仿真只证明候选包安装/加载和语义，不代表原生x64性能；正式生产实现仍须完整门禁与CI。生产依赖尚未增加。

## 已查清的库行为

- 仅设 `failOn: warning` 仍会容忍部分不完整PNG/GIF、GIF短像素流，APNG会静默变成首帧。因此另核对PNG块CRC/结尾、GIF块与LZW完整像素数；APNG明确拒绝。完整原生像素解码继续执行。
- libvips的GIF循环计数使用总播放次数，文件里的NETSCAPE字段使用额外重复次数；核对以文件语义为准。短时长会被库改成浏览器风格的默认值，输出GIF的GCE时长要保留原值。
- WebP动画优化器会合并重复帧，甚至在有损近似后合帧；诊断方案把完整解出的每帧交给原生库做无损编码，再按公开RIFF/ANMF规范封装，保留重复帧、原始毫秒时长与循环。只编写容器封装，不另写图像编解码器。
- 一个透明动画生成样本缺少VP8X alpha标志，造成Pillow与libvips对背景透明度的解释不同。旧字节/失败保留于`mac-05-source`；新生成器显式标记受控RGBA画布，独立解码预期才一致。没有改断言把丢透明度当成功。
- 1GiB地址空间会挡住1600万像素WebP的输出复查，1536MiB复验通过。32M总像素动画还触发libvips默认100MiB后落临时文件的行为；子进程固定 `VIPS_DISC_THRESHOLD=256m`，在只读容器复验通过，无需开放临时目录。
- Linux最终样本最大墙钟约1.55秒、单子进程maxRSS约437MiB，整容器cgroup峰值约415MiB、无OOM；两种计量并不相等。生产硬边界是Linux进程地址空间1536MiB，512MiB是本次实验容器上限，不能冒称生产子进程512MiB硬上限。

失败轮次（包括Linux首轮报告写入权限错误）原样保留。S3按正式测试重新实现格式、进程与存储契约，不直接把这里的诊断调度或格式实验搬进生产。
