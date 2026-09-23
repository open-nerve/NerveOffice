# NerveOffice

自部署、单租户的团队在线文档平台，提供在线表格与文字文档。基于 [Univer](https://github.com/dream-num/univer) 开源 SDK（Apache-2.0）构建，不依赖 Univer Pro。

> 当前阶段：规划完成，准备进入 M0 技术验证，尚无可运行代码。

## 核心设计

- 单文档单写者，编辑权可以交接；不同文档可以并行编辑，不做实时协同
- 个人空间 + 团队空间，文档级分享
- 本地优先保存：修改先写入本机加密发件箱，再同步到服务器，断网不丢内容
- Node.js / TypeScript + PostgreSQL，模块化单体

## 文档

- [00 项目计划书](docs/v0.1/00-项目计划书.md)：范围、架构、评审决策与 M0 验证清单

## 参考源码

`refer/univer` 是只读的 Univer 参考源码，不纳入本仓库。获取方式：

```bash
git clone --depth 1 https://github.com/dream-num/univer.git refer/univer
```

M0 锁定 SDK 版本后，改为检出与 npm 依赖版本一致的 tag，例如 `--branch v1.0.0`。

## 许可证

[Apache-2.0](LICENSE)
