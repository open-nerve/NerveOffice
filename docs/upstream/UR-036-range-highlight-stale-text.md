# UR-036 范围高亮用旧语法树覆盖快速输入

> 状态：草稿，未发送上游。固定 `@univerjs/sheets-formula-ui@1.0.1` 发布包的正式宿主复现；其他版本未核对。M5-P3-S4 最终工程、558 项三浏览器回归和单轮审查修正完成，见 [S4 复核](../v0.1/M5-表格能力与资源/reviews/P3-S4-表格能力逐项复核.md)；P3 阶段验收待 S6。

在数据验证详情的范围画布中选中原来的 `C3`，快速逐字输入 `C3:C4`，再点击“忽略空值”并确认。原包曾把实际内部文档改成 `C\r\nC4\nC\nC`，随后范围命令收到 NaN 行号，规则矩阵删除了规则。整段 input 事件和每键 20 ms 的对照正确；这些对照只用于定位，正式回归保留无附加延迟的逐字输入。

`useRangesHighlight` 的一个 effect 读取当前编辑器文本并异步更新 `sequenceNodes`，另一个 effect 调用 `useDocHight`。新文本已经进入编辑器时，后一 effect 仍可能使用上一轮的语法树；高亮函数根据该语法树重建 dataStream，再经实际 `ReplaceTextRunsCommand` 写回，于是覆盖用户的新输入。

本地修复只改高亮调用：执行时配对读取当前文本和其解析结果，显式传入原文本。不改变范围选择、解析器、输入事件、撤销或公式引擎。ES/CJS 同步，登记见 `patches/univer-range-highlight.json` 与 ADR-010。数据验证面板另有 `isValidRange` 和工作表边界检查，避免无效输入破坏已有规则；它不能代替高亮修复。

证据在主项目 `.codex/handoffs/m5-p3-20261020/s4/`：

- `panel-range-diagnostic03` 保存原始文本和真实范围命令；04/06 是整段输入/20 ms 对照。
- `panel-range-diagnostic07`：恢复原速后连续 5 次通过。
- `highlight-mutation-browser01`：只恢复原高亮、保留其他修复，3 次均在服务器范围断言失败；不是因输入控件定位、权限或页面错误失败。
- 正式回归：`tests/e2e/specs/editor/data-validation-panel.spec.ts` 的“范围之后立即改设置”；操作走正式 UI，服务器同时保留范围 C3:C4 和 allowBlank=false。
- `panel-compatibility01` 为三浏览器 42 项面板/自动保存兼容；`panel-running02` 为三浏览器 18 项公开运行态，均零跳过、零重试、零 flaky。`panel-running01` 的 Chrome 失败是全选误作用到主表（原文字被追加成 C3C3:C4），与本缺陷的乱码不同；点画布内实际文字区域并核对焦点与主表选区后，`panel-focus-running03` 的两条故事各 5 次均通过。校准过程的失败原件保留。

移除条件：上游实际发布包在同一快速输入、连续范围/设置、无效范围修正、重开以及相关规则/公式编辑回归中通过；重新核对高亮不回写旧文本，再移除补丁。不得仅以慢速输入成功或解析器单测通过认定已修复。
