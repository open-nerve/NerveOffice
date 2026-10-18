# 图片原生库：对应源码与许可资料

适用版本为 Sharp **0.35.5**、`@img/sharp-libvips-*` **1.3.4**、实际 libvips **8.18.7**；已核对平台为 macOS ARM64、Linux glibc ARM64/x64。决策与运行预算见 [ADR-021](../../docs/adr/ADR-021-图片处理与资源边界.md)。NerveOffice 继续按 Apache-2.0 发布，各第三方库按各自条款发布。

**当前状态（P1-S6）**：来源与声明校验、完整收集和离线成品复核已接入正式镜像及部署验证。P1 最终验收仍须核对完整门禁和同一 main 提交的 CI；进度与原始证据见 [P1 交接单](../../docs/v0.1/M5-表格能力与资源/handoffs/P1-交接单.md)。

## 材料

- `sources.json`：398 个材料的路径、URL、字节数、SHA-256，共约 193 MiB。含 29 个原生/构建源码归档、5 份补丁、librsvg 发布归档 Cargo.lock 的全部 357 份 crate，以及 GPL/LGPL 与同提交许可补件。
- `inputs/`：15 份材料的原样副本（构建归档、补丁、许可补件）。其中上游 PR 补丁等 URL 可能继续变化；libtiff 4.7.2 与 fontconfig 2.18.3 的 GitLab 归档下载曾返回 HTTP 406，因此这两份已审原件也随仓库保存。分发使用仓库中已有副本并验证原大小与摘要，清单保留原 URL，不用变化后的网络内容悄悄替换。
- `notices-index.json`：每份许可/声明的原始归档路径、摘要与编码，以及缺少独立 LICENSE 的 13 个 crate 的补齐方式。
- [完整许可正文](../../apps/api/third-party-licenses/native-images/LICENSE)：GPLv3、LGPLv3、上游附带库声明，以及原生/Rust 来源中的许可和原始版权声明。三个平台包的 `LICENSE` 通过仓库内链接共享这份正文，现有服务端许可生成器读取全文。

部分源码包包含构建、测试或其他平台依赖。材料保留这些来源，不声称它们全部链接进当前平台二进制。`r-efi` 的许可在原始 `AUTHORS` 中；其他缺独立许可文件的包按同提交正文或其明确声明的标准许可补齐，并保留原始 Cargo/README/源码头部声明。不推定版权年份，不把其他包的版权行移植过来。源文件其余部分仍在完整对应归档中。

`native/GPL-3.0` 沿用取证时的文件名，实际内容是 gnulib 原始许可概述，汇总中的标题已如实标明；它不代替 GPLv3 全文。完整 GPLv3 文本已原样收在 lcms 来源的 `plugins/fast_float/COPYING.GPL3` 对应节。pixman 的原始空 `AUTHORS` 也保留零字节事实，不把空文件当成许可正文。

更新任何版本或平台时，必须重新核对本清单、许可正文、原生链接、处理语义与资源预算；`tools/src/gates/policy.ts` 的例外同时匹配包名、精确版本和许可，不全局允许 LGPL。

## 收集与离线复核

在仓库根目录运行 `node tools/src/deploy/native-image-cli.ts --out <全新输出目录> --cache <缓存目录>`。输出的父目录和缓存父目录须存在。已有输出一律拒绝覆盖；缺少缓存才按清单 HTTPS 获取，至多四个流，每份有总时限、精确字节上限和 SHA-256。缓存与仓库补件同样校验，损坏时停止，不重写清单或覆盖坏缓存来掩盖问题。

成品中 `sources/` 包含清单列出的全部 398 份原件，另有 `sources.json`、`notices-index.json`、完整 `LICENSE` 与本说明；`BUNDLE.json` 最后写入，列出全部分发文件的实际摘要。索引中的源码路径相对成品的 `sources/`，`noticeBook.path` 保留仓库出处，成品正文在同目录 `LICENSE`。文件原有 URL 和归档成员名保持，用于追溯，读取或替换库不需要联网。

运行 `node tools/src/deploy/native-image-cli.ts --verify <成品目录>` 离线复核全部文件、版本、数量、字节和声明正文。缺件、额外文件、符号链接、大小或摘要不符均失败；仅有回执文件不代表通过。工具不解包或执行来源里的代码，构建脚本只是发行材料。

## 构建输入与复建路线

1. 按清单取得全部归档，逐份比较字节数和 SHA-256；有 `vendoredPath` 时优先用仓库内副本。不得执行未核对的归档/补丁。正式发行中这些副本必须与二进制一起可获取，不能只保留 URL。
2. `native/sharp-libvips-build` 是上游 v1.3.4 的完整构建工程，包含 `versions.properties`、`build.sh`、`build/posix.sh` 与各平台 Dockerfile/交叉编译设置。先阅读其 README 和构建脚本；Linux 的平台参数为 `linux-x64` 或 `linux-arm64v8`，macOS ARM64 为 `darwin-arm64v8`。
3. 依 `versions.properties` 使用清单中相同版本的来源；把上游脚本的网络下载步骤改为使用已校验的本地归档和补丁。原始构建脚本不在 NerveOffice 的安装或启动过程中自动执行。
4. librsvg 2.63.2 的原始 Cargo.lock 位于其发布源码中。上游脚本删去内嵌 GIF/WebP、Cairo PDF/PS 特性后执行 `cargo update --workspace`，再应用已收录补丁。保留原锁文件和清单内全部 crate；复建时记录锁文件变化，不能用未审查的新版本替代。这里提供构建来源和步骤，不声明位级可复现。
5. 在对应平台构建共享库，保留原许可证与修改说明；验证 SONAME、依赖和图像回归后用于派生镜像。S6 验收会核对正式镜像、已安装包版本和本材料版本一致。

## 替换兼容共享库

NerveOffice 通过 Sharp 原生绑定加载可替换共享 libvips；没有把它静态链接进应用。Linux 的共享库为 `libvips-cpp.so.8.18.7`，macOS 为 `libvips-cpp.8.18.7.dylib`。它位于对应 `@img/sharp-libvips-<平台>` 包的 `lib/` 下；实际目录随 pnpm 链接结构解析，不能改错其他版本的副本。

运行镜像中的程序文件归 root 所有，正常应用用户不能覆盖它们；维护者可以构建派生镜像，将自行构建的兼容共享库替换到相同位置。修改后保持绑定所需的 ABI/SONAME 和运行依赖，重新验证四格式、动画和资源限制，再部署派生镜像。macOS 开发环境同样可在本机包目录替换兼容 dylib 并验证。

本项目不新增禁止修改库、替换兼容库或为调试修改而逆向的条款。替换库自身的源码与许可仍按其许可证提供；NerveOffice 的许可证与这些库分别说明。
