# NerveOffice

自部署、单租户的团队在线文档平台，提供在线表格与文字文档。基于 [Univer](https://github.com/dream-num/univer) 开源 SDK（Apache-2.0）构建，不依赖 Univer Pro。

> 当前阶段：M0 技术验证已完成（标签 `v0.1-m0`）；M1 工程底座与行走骨架进行中：工程底座、服务端基础设施、账户与个人空间已完成，接下来是编辑器接入与在线保存、容器与部署。`spikes/` 下是 M0 的验证工程，不进入生产。

## 核心设计

- 单文档单写者，编辑权可以交接；不同文档可以并行编辑，不做实时协同
- 个人空间 + 团队空间，文档级分享
- 本地优先保存：修改先写入本机加密发件箱，再同步到服务器，断网不丢内容
- Node.js / TypeScript + PostgreSQL，模块化单体

## 文档

- [00 项目计划书](docs/v0.1/00-项目计划书.md)：范围、架构、评审决策与里程碑（r3 已按 M0 的结论修订）
- [M0 结束评审](docs/v0.1/M0-技术验证/reviews/M0-结束评审.md)、[M0 交接单](docs/v0.1/M0-技术验证/handoffs/M0-交接单.md)：M0 的结论与交给后续的事项
- [能力矩阵](docs/v0.1/M0-技术验证/reports/能力矩阵.md)、[插件档案 v1](docs/v0.1/M0-技术验证/reports/插件档案v1.md)：表格与文字文档的能力结论、固定使用的插件与配置
- [延期事项登记](docs/v0.1/02-延期事项登记.md)

## 参考源码

`refer/univer` 是只读的 Univer 参考源码，不纳入本仓库。SDK 版本锁定为 1.0.0，参考源码检出对应的 tag：

```bash
git clone --depth 1 --branch v1.0.0 https://github.com/dream-num/univer.git refer/univer
```

## 许可证

[Apache-2.0](LICENSE)
