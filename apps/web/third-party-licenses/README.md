# 第三方许可的补充正文

打进前端产物的包里没有许可文件时，构建从这里取许可正文写进 THIRD-PARTY-LICENSES.md（门禁 `artifacts` 的许可清单检查）。
目录按包名放置：`<包名>/LICENSE`，带作用域的包是 `@作用域/包名/LICENSE`。每一份的出处：

| 包 | 声明的许可 | 正文的出处 |
|---|---|---|
| `@univerjs/protocol` 1.0.1 | Apache-2.0 | 发布包里没有许可文件；Univer 的各个包同一个仓库、同一份许可，取自 `@univerjs/core` 1.0.1 发布包里的 LICENSE |
| `franc-min` 6.2.0 | MIT | 仓库 wooorm/franc 标签 6.2.0 的 license（franc-min 是这个仓库里的包） |
| `ot-json1` 1.0.2 | ISC | 发布包 README 的"License"一节 |
| `ot-text-unicode` 4.0.0 | ISC | 发布包 README 的"License"一节（正文是 MIT 许可；两种许可都在允许清单里） |
| `react-remove-scroll-bar` 2.3.8 | MIT | 仓库 theKashey/react-remove-scroll-bar 的 LICENSE（2025-05-21 加进仓库，2.3.8 的发布包里没有） |
| `unicount` 1.1.0 | ISC | 发布包 README 的"LICENSE"一节 |
