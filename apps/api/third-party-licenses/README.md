# 服务端依赖的许可补充正文

镜像里的后端依赖的包里没有许可文件时，生成服务端的第三方许可清单（`node tools/src/deploy/cli.ts server-licenses`，镜像构建时执行）从这里取许可正文。
找不到正文时生成失败，不静默跳过。目录按包名放置：`<包名>/LICENSE`，带作用域的包是 `@作用域/包名/LICENSE`。每一份的出处：

| 包 | 声明的许可 | 正文的出处 |
|---|---|---|
| `@node-rs/argon2-darwin-arm64`、`-linux-x64-gnu`、`-linux-arm64-gnu` 2.2.1 | MIT | 各平台的预编译包与 `@node-rs/argon2` 同一个仓库（napi-rs/node-rs）、同一份许可，取自 `@node-rs/argon2` 2.2.1 发布包里的 LICENSE。只放了本机开发（macOS arm64）与镜像（linux amd64、arm64，glibc）用到的平台，别的平台缺正文时照样补 |
| `@tokenizer/token` 0.3.0 | MIT | 发布包 README 的"Licence"一节 |
| `drizzle-orm` 0.45.3 | Apache-2.0 | 仓库 drizzle-team/drizzle-orm 标签 0.45.3 的 LICENSE |
| `pg-types` 2.2.0 | MIT | 发布包 README 的"license"一节 |
| `pgpass` 1.0.5 | MIT | 发布包 README 的"License"一节 |
