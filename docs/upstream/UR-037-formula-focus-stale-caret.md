# UR-037 编辑栏切回单元格时旧光标覆盖新输入位置

状态：本地修复、S4 最终回归与单轮审查修正完成；尚未向上游发送。固定版本 `@univerjs/sheets-formula-ui@1.0.1`。发现于 M5-P3-S4 Task 2；最终 558 项三浏览器与工程回执见 [S4 复核](../v0.1/M5-表格能力与资源/reviews/P3-S4-表格能力逐项复核.md)。

## 实际反例

正式宿主中先从上方编辑栏输入 `bar-entry`，再选一个单元格、原速键入 `new-text`，服务器保存为 `ew-textn`。完整内容故事中 `cut-value` 保存为 `ut-valuec`。名称框与鼠标选格均出现；选格后多等两帧无效。不经过编辑栏的普通输入、复制后覆盖、复制撤销重做后覆盖对照通过。

外部原件：`.codex/handoffs/m5-p3-20261020/s4/` 下 `content-diagnostic03–06`、`overwrite-minimal01–05`。其中 minimal02 的撤销未回到表格焦点、minimal04 的账号前缀过长属于夹具错误，不能当产品反例；校准后 minimal03 通过、minimal05 仍在最终服务器值断言失败。

## 根因与修复设计

`InsertTextCommand` 插入首字母后，实际文档变更携带位置 1 的新光标；渲染选区尚是位置 0。`FormulaEditor` 的布局 effect 调用 `focusFormulaEditor`，其中先 `editorService.focus()`，随后才读取要保留的选区。切换焦点触发 blur，`DocSelectionRenderService._setEditing` 发出旧渲染选区，覆盖新逻辑光标；函数再把已经过期的位置 0 设置回去。后续字符从位置 0 插入，首字母落到末尾。diagnostic06 的调用栈记录了这条链。

在既有 `focusFormulaEditor` 入口先保存当前逻辑选区，再执行焦点切换并恢复它。显式 offset 优先、正在鼠标拖选时不重置、原本没有选区时定位到正文末尾等语义保持。修改同一个固定包的 ES/CJS，不增加公开导出、内部服务接线、数据字段或保存通道。

## 验证与移除条件

以当前正式 UI 的原速输入为反例，补编辑栏与单元格来回切换、覆盖/追加、复制剪切、撤销重做、保存重开与查看者对照；不以减慢键入或移除失败路径代替修复。需 Chromium、Chrome、WebKit 及公开 running 复验，并恢复原函数做有效变异。画布与浏览器焦点的真实顺序由这些 E2E 证明，静态 CJS 检查不等于原生 CJS 浏览器运行证据。

上游修复后，三浏览器反例与相关面板/链接/图片链路全部通过，方可删除本地补丁段。`capabilities-compatibility01` 与 `capabilities-running01` 各 21/21（三浏览器各 7 项），无重试/跳过/flaky；`focus-mutation-browser01` 恢复原函数的名称框/鼠标两条故事均在 `new-text→ew-textn` 的服务器值断言失败，恢复后的输入绑定于 `task2-evidence.json`。`focus-mutation-result01.json` 原检查器受 ANSI 分段影响误判为 false，原件保留，`focus-mutation-audit01.json` 对同一原报告规范化后确认两条有效反例。CJS 静态检查无新增未定义符号。Step 最终结果绑定于 `final03-resumed-evidence.json`，不以 Task 2 过程结果代替最终相关回归。
