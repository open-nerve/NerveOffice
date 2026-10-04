# P2-S1 真实 Safari 复核：只读入口的页面自检

> 执行：P2-S1 的实现者（子 Agent，模型 `claude-opus-5-5`）｜日期：2026-10-04｜依据：P2 设计 §3.5、实施计划 S1、DEF-003（阅读模式部分）｜代码：`m3-p2-safari` 分支的 `f2b7e7d`（基于 `6a41861`）｜环境：本机 macOS 27.0、Safari 27.0（UA `Version/27.0 Safari/605.1.15`）；对照 Playwright 1.63 的 WebKit 26.6、Chromium 153、Chrome 154（无头）
>
> **结论**：M2-P3 只读入口清单里能用 Facade 与合成事件执行的部分，共 53 项检查（三个场景），在真实 Safari 27.0 上四次都全部通过，与 Playwright 的 WebKit、Chromium、Chrome 逐项一致；没有页面错误，也没有 `console.error`。**真实 Safari 上没有发现只读的缺口。**
> 另有一个环境上的发现（§四 F1）：Safari 暂停隐藏的页面——窗口不在前面时，`open -g` 打开的标签页一开始就是 hidden，动画帧一帧都没有，计时器约 6 秒之后停止。自检因此要在 Safari 的窗口露出来时跑（驱动脚本加了 `--front`，页面一开始就隐藏时自检立即交回原因）；它对编辑租约的心跳与 P4 的自动保存也有影响，交主会话判断。

## 一、做法

Playwright 只能驱动它自带的 WebKit，驱动不了真实 Safari（M0-P1 报告 §3.2）。所以检查编进测试构建、由编辑器页自己做，驱动脚本只负责起服务、造场景、打开 Safari、收结果。

1. **自检的入口页** `apps/web/selftest.html`（`entries/selftest/`，只在测试构建里，与 CSP 探针同一个做法）：从地址的 `#` 片段读测试账户、文档、场景与结果交回的地址，读完立即从地址里去掉（片段不发给服务器，历史记录里也没有密码）；同源登录（与登录页同一个接口），再整页跳到编辑器页并带上 `selftest=<场景>&next=<收集端>`。登录失败时同样交回结果（写明原因）。
2. **编辑器页的挂接** `features/sheet-editor/selftest-hook.ts`：`start.tsx` 只在测试构建、地址带 `selftest` 时动态引入它（在 `page.load()` 之前，两行）。它挂上页面错误的收集（`error`、`unhandledrejection`、包装的 `console.error`，ResizeObserver 的通知另记，与 E2E 的 `page-errors.ts` 同一个判断）与可见性的记录，订阅页面的状态，到 steady 之后（或载入失败、90 秒等不到、页面一开始就在后台）才动态引入自检模块。
3. **自检模块** `editor/testing/selftest.ts`（与 `selftest-dom.ts`）：用 E2E 的探针（`window.__nerveEditorProbe`）执行编译进测试构建的检查，每项比较执行前后的内存快照与命令日志，等确定的信号（命令被取消、被权限检查拦下并弹出只读的提示、执行完），不用固定时长；被拦下时核对提示的说法、点"确定"关掉。按键与右键用合成事件（`isTrusted` 为假：Univer 的快捷键服务与画布的指针处理都不看它）；找界面元素按可访问的角色与名称（不写 SDK 的 `data-u-comp`，lint 只许 internal-api 写）。每项有时限，一个场景有总时限（180 秒），页面中途被隐藏时余下的检查不做——超时、隐藏也照样把结果交回，看得到卡在哪里。
4. **共用一份清单**：入口清单、预期、提示的说法与比较口径从 `read-only.spec.ts` 抽到 `editor/testing/read-only-entries.ts`（Facade 入口 22 项、经 Facade 写公式的 mutation、快捷键入口的预期、`READ_ONLY_ALERT`）与 `content-compare.ts`（`contentOf`、"改文档的 mutation"的判定），E2E 与自检都引用它们（模块边界只给这三个不引用任何模块的文件开口；单元测试核对提示与语言包一致、判定与编辑器的变更检测一致、每个 Facade 调用序列化之后照样能执行）。
5. **结果怎么交回（取舍）**：页面的 CSP 只许同源连接（`connect-src 'self'`），E2E 的后端是生产的后端、没有收结果的接口。可选的三条路：
   - 给后端加一个只在 E2E 模式下存在的收集接口：生产代码里多一个测试钩子，路由表、权限矩阵、"看不到与不存在一致"的自动核对都要为它开例外，而且后端正由另一位实现者在改——不选；
   - 驱动脚本起反向代理、在同源上收结果：后端的公开地址要改成代理的（`support/serve.ts` 要动），测的网络路径也多了一跳——不选；
   - **整页跳转**：顶层跳转不受 CSP 限制。自检结束时页面跳到 `next`（驱动脚本起的收集端），结果 gzip 之后 base64url 放在查询参数里（一般 1–3 KB）；收集端收下这一步，用 303 把页面带到下一步的入口页，最后停在结束页。后端与 `serve.ts` 都不用改——**选这条**。它的代价是中途看不到进度，所以自检加了总时限与"页面隐藏就交回"（第 3 条）。
6. **驱动脚本** `tests/e2e/safari/selftest.ts`（`pnpm --filter @nerve-office/e2e run safari:selftest`，不进 CI）：用 Playwright 同一个服务脚本（`support/serve.ts`）起后端（端口按次挑，库名带进程号，结束时删库）；写库造场景（查看者、作者、只读样本与去掉公式缓存值的样本）；起收集端；`open -g -a Safari` 在后台打开第一步（`--front` 时带到前台）；等全部结果（默认 900 秒），核对服务器上的两份文档修订号仍是 1（没有保存过），写 `tests/e2e/test-results/safari/<时间>.json`（Safari 与 macOS 的版本、每步每项的结果、页面错误、服务器上的核对）。退出码：0 全部通过，1 有不通过，2 超时，3 准备阶段失败。
7. **自检本身的校准**：`tests/e2e/specs/editor/selftest.spec.ts` 在 Playwright 的浏览器里跑同样的入口页、自检与结果的交回（`next` 指向一个拦下的地址），核对每项都通过——自检写对了，真实 Safari 上的不通过才说明 Safari 不同；它随 CI 每次跑，自检不会悄悄地坏掉。变异验证（Playwright 的 WebKit）：只读守卫不取消撤销 → `facade.undo-redo`、`shortcut.undo-redo` 不通过；防火墙放过筛选的 mutation → `facade.筛选` 不通过（之后的内容核对随之不通过）；只读时打开右键菜单 → `context-menu.cell.absent` 不通过。

场景（`editor/testing/selftest-report.ts` 的 `SELFTEST_SCENARIOS`）：

| 场景 | 谁、打开什么 | 检查 |
|---|---|---|
| `read-only` | 查看者，只读样本 | 页头只读；打开不产生改动（内存快照与服务器上的逐字节相同、就绪之后没有改文档的 mutation 的尝试、保护类资源为空）；M0 的 Facade 入口 22 项；经 Facade 写公式的 mutation（M2-P6 复核 F3）；撤销与重做（Facade 与快捷键）；快捷键入口：查找（校准）、加粗/斜体/下划线、删除、"搜索功能"、快速求和、替换；界面：工具栏、底栏菜单、单元格与工作表标签的右键菜单；最后内容不变（42 项） |
| `read-only-formulas` | 查看者，去掉公式缓存值的样本 | 公式在 Worker 里算出结果、结果的写回不算修改、服务器上的内容不变（4 项；另由驱动脚本核对 6 个公式的值与 `read-only.spec.ts` 同一组） |
| `edit-chrome` | 作者（能编辑），只读样本 | 只读时"没有"的对照：页头可编辑、工具栏与底栏菜单都在、合成的右键弹出单元格与标签的菜单（按 Escape 关掉）、合成的查找快捷键有效、内容不变（7 项） |

## 二、结果

### 2.1 各次运行

| 运行 | 打开方式 | Safari 的窗口 | 结果 |
|---|---|---|---|
| 1（02:42） | `open -g` | 不在前面 | 超时（退出码 2）：后端的日志里，页面登录、读了详情与内容，3.7 秒之后自检读了一次服务器上的内容（`open.server-content`），之后再没有请求，也没有交回结果 |
| 可见性探针 | `open -g` / `open -a` | 不在前面 / 带到前台 | 一个只报计时与动画帧的空白页（不入库）：后台时 `visibilityState` 一开始就是 `hidden`、动画帧 0 帧、1 秒一次的计时器跑了 6 次就停了（60 秒里）；前台时 `visible`、每秒约 72 帧、计时器一直在走 |
| 2（02:55） | `open -g` | 不在前面，中途被带到前台 | `read-only` 8/42：页面一开始就是 hidden（这一版还没有"一开始就隐藏立即交回"），前 8 项（页头、打开不产生改动的 3 项、前 4 个 Facade 入口）照常通过，第 9 项（工作表改名，要弹出并关掉提示）卡住；Safari 被带到前台时页面恢复，场景已超过总时限，余下的没做、交回。`read-only-formulas` 4/4。`edit-chrome` 没有交回（又回到后台）。退出码 2 |
| **3（03:11）** | `--front` | 前台 | **53/53 通过**，18 秒跑完，退出码 0 |
| **4（03:16）** | `--front` | 前台 | **53/53 通过**，退出码 0 |
| **5（03:17）** | `open -g`（默认） | 前一次留在前台 | **53/53 通过**，退出码 0 |
| **6（03:27）** | `--front` | 前台 | **53/53 通过**，退出码 0：提交的代码（`f2b7e7d`）再跑一次（第 5 次之后只改了注释、一处类型的写法、一项检查在前一项没做完时的说明与驱动脚本的日志，通过时的行为不变） |

第 3–6 次：三个场景的可见性都是 `visible`、自始至终没有变；页面错误、`console.error`、浏览器的通知都是 0；服务器上两份文档的修订号仍是 1。第 5 次说明 `open -g` 本身没有问题，问题只在页面是不是看得见。

### 2.2 逐项（第 3–5 次的 Safari，与同一时期 Playwright 的三个浏览器）

表里是每项用的毫秒数；"Safari 看到的"取第 3 次。第 6 次逐项的结论与说明相同。Playwright 的结果取自同一时期 `selftest.spec.ts` 的附件（三个浏览器一次，提交之后又在三个浏览器上跑了一次，9 条全部通过）。

#### read-only

| 检查 | Safari 27.0（3 次） | WebKit 26.6 | Chromium 153 | Chrome 154 | Safari 看到的 |
|---|---|---|---|---|---|
| `page.read-only` | 通过 1/1/0 | 通过 0 | 通过 0 | 通过 0 | 页头只能查看，没有保存按钮 |
| `open.server-content` | 通过 21/27/22 | 通过 17 | 通过 29 | 通过 36 | 内存快照与服务器上的内容逐字节相同（17354 字符） |
| `open.no-change-attempts` | 通过 1/1/0 | 通过 0 | 通过 0 | 通过 0 | 就绪之后 18 条命令，没有改动文档的 mutation 的尝试 |
| `open.resources` | 通过 0/0/1 | 通过 0 | 通过 0 | 通过 0 | 保护类资源为空，没有本地授权服务的资源 |
| `facade.筛选` | 通过 2/2/2 | 通过 3 | 通过 3 | 通过 3 | 取消了 sheet.mutation.set-filter-range |
| `facade.排序` | 通过 6/6/5 | 通过 6 | 通过 5 | 通过 6 | 取消了 sheet.mutation.reorder-range |
| `facade.新增工作表` | 通过 1/1/2 | 通过 2 | 通过 1 | 通过 1 | 取消了 sheet.mutation.insert-sheet；调用抛出 TypeError（取消之后 Facade 仍去取新表，与 E2E 相同，不是页面错误） |
| `facade.删除工作表` | 通过 2/3/2 | 通过 3 | 通过 3 | 通过 3 | 取消了 sheet.mutation.remove-sheet |
| `facade.工作表改名` | 通过 239/210/213 | 通过 227 | 通过 210 | 通过 237 | 权限检查拦下 sheet.command.set-worksheet-name，提示"这份文档只能查看，不能调整工作表。" |
| `facade.复制工作表` | 通过 1/2/2 | 通过 2 | 通过 2 | 通过 2 | 取消了 sheet.mutation.insert-sheet |
| `facade.隐藏工作表` | 通过 1/1/1 | 通过 1 | 通过 1 | 通过 1 | 取消了 sheet.mutation.set-worksheet-hidden |
| `facade.移动工作表` | 通过 196/193/193 | 通过 218 | 通过 212 | 通过 211 | 权限检查拦下 sheet.command.set-worksheet-order，提示"这份文档只能查看，不能调整工作表。" |
| `facade.移动图片` | 通过 196/196/199 | 通过 196 | 通过 185 | 通过 212 | 权限检查拦下 sheet.command.set-sheet-image，提示"这份文档只能查看，不能修改图片。" |
| `facade.删除图片` | 通过 224/196/195 | 通过 196 | 通过 210 | 通过 212 | 权限检查拦下 sheet.command.remove-sheet-image，提示"这份文档只能查看，不能修改图片。" |
| `facade.缩放图片` | 通过 196/196/196 | 通过 196 | 通过 209 | 通过 184 | 权限检查拦下 sheet.command.set-sheet-image，提示"这份文档只能查看，不能修改图片。" |
| `facade.设行高` | 通过 196/196/196 | 通过 199 | 通过 182 | 通过 210 | 权限检查拦下 sheet.command.set-row-height，提示"这份文档只能查看，不能调整行列。" |
| `facade.插入行` | 通过 198/196/196 | 通过 225 | 通过 209 | 通过 211 | 权限检查拦下 sheet.command.insert-row-by-range，提示"这份文档只能查看，不能插入行列。" |
| `facade.删除行` | 通过 198/196/200 | 通过 224 | 通过 207 | 通过 185 | 权限检查拦下 sheet.command.remove-row-by-range，提示"这份文档只能查看，不能删除行列。" |
| `facade.合并单元格` | 通过 2/2/1 | 通过 2 | 通过 2 | 通过 2 | 取消了 sheet.mutation.add-worksheet-merge |
| `facade.加粗` | 通过 226/198/198 | 通过 198 | 通过 184 | 通过 210 | 权限检查拦下 sheet.command.set-style，提示"这份文档只能查看，不能修改格式。" |
| `facade.条件格式` | 通过 196/196/196 | 通过 197 | 通过 206 | 通过 186 | 权限检查拦下 sheet.command.add-conditional-rule，提示"这份文档只能查看，不能修改条件格式。" |
| `facade.数据验证` | 通过 197/196/196 | 通过 227 | 通过 208 | 通过 211 | 权限检查拦下 sheet.command.addDataValidation，提示"这份文档只能查看，不能修改数据验证。" |
| `facade.超链接` | 通过 1/1/1 | 通过 1 | 通过 1 | 通过 1 | 取消了 sheets.command.add-hyper-link |
| `facade.批注` | 通过 0/1/1 | 通过 1 | 通过 1 | 通过 1 | 取消了 sheet.mutation.update-note |
| `facade.全部替换` | 通过 210/210/210 | 通过 238 | 通过 223 | 通过 247 | 权限检查拦下 sheet.command.set-range-values，提示"这份文档只能查看，不能修改。" |
| `facade.取消已有的超链接（"功能"表 H3）` | 通过 3/2/2 | 通过 2 | 通过 2 | 通过 2 | 取消了 sheet.mutation.set-range-values |
| `facade.写公式的 mutation` | 通过 1/5/1 | 通过 1 | 通过 1 | 通过 1 | 取消了 sheet.mutation.set-range-values，K40 没有公式，本文档上没有 mutation 执行 |
| `facade.undo-redo` | 通过 2/1/1 | 通过 1 | 通过 1 | 通过 1 | 取消了 univer.command.undo；取消了 univer.command.redo |
| `shortcut.find` | 通过 74/82/67 | 通过 66 | 通过 61 | 通过 63 | 执行完 ui.operation.open-find-dialog，查找面板出现并关掉 |
| `shortcut.undo-redo` | 通过 8/8/8 | 通过 10 | 通过 7 | 通过 7 | 取消了 univer.command.undo；取消了 univer.command.redo |
| `shortcut.bold` | 通过 180/183/197 | 通过 186 | 通过 190 | 通过 193 | 权限检查拦下 sheet.command.set-style，提示"这份文档只能查看，不能修改格式。" |
| `shortcut.italic` | 通过 176/181/182 | 通过 205 | 通过 186 | 通过 160 | 同上 |
| `shortcut.underline` | 通过 200/201/173 | 通过 178 | 通过 187 | 通过 186 | 同上 |
| `shortcut.delete` | 通过 208/180/184 | 通过 211 | 通过 166 | 通过 193 | 权限检查拦下 sheet.command.clear-selection-content，提示"这份文档只能查看，不能修改。" |
| `shortcut.feature-search` | 通过 28/34/32 | 通过 26 | 通过 22 | 通过 30 | 取消了 ui.operation.open-feature-search，面板没有出现 |
| `shortcut.quick-sum` | 通过 27/23/28 | 通过 31 | 通过 34 | 通过 33 | 取消了 formula-ui.operation.insert-function，编辑栏仍是空的 |
| `shortcut.replace` | 通过 34/23/28 | 通过 34 | 通过 33 | 通过 34 | 取消了 ui.operation.open-replace-dialog，面板没有出现 |
| `chrome.toolbar.absent` | 通过 0/0/0 | 通过 0 | 通过 0 | 通过 0 | 没有功能区、工具栏与命令 |
| `chrome.footer.absent` | 通过 0/0/0 | 通过 0 | 通过 0 | 通过 1 | 底栏没有网格线开关 |
| `context-menu.cell.absent` | 通过 27/25/34 | 通过 33 | 通过 33 | 通过 32 | 两帧之后页面上没有单元格的右键菜单（"选择性复制"） |
| `context-menu.sheet-tab.absent` | 通过 67/70/78 | 通过 76 | 通过 78 | 通过 77 | 两帧之后页面上没有工作表标签的右键菜单（"重命名"） |
| `content.final` | 通过 1/2/2 | 通过 1 | 通过 2 | 通过 1 | 内存里的内容与打开时相同，就绪之后没有改动文档的 mutation 执行 |

#### read-only-formulas

| 检查 | Safari 27.0（3 次） | WebKit 26.6 | Chromium 153 | Chrome 154 | Safari 看到的 |
|---|---|---|---|---|---|
| `page.read-only` | 通过 0/1/1 | 通过 0 | 通过 0 | 通过 0 | 页头只能查看，没有保存按钮 |
| `formulas.computed` | 通过 27/44/35 | 通过 18 | 通过 23 | 通过 23 | 6 个公式都算出了结果（值与 `read-only.spec.ts` 的同一组相同：苹果-12、70、14、70、70、苹果） |
| `formulas.no-change-attempts` | 通过 0/0/0 | 通过 0 | 通过 0 | 通过 0 | 结果的写回都不算修改，没有被防火墙取消 |
| `formulas.server-unchanged` | 通过 23/49/25 | 通过 10 | 通过 16 | 通过 11 | 服务器上的内容不变 |

#### edit-chrome（对照）

| 检查 | Safari 27.0（3 次） | WebKit 26.6 | Chromium 153 | Chrome 154 | Safari 看到的 |
|---|---|---|---|---|---|
| `page.editable` | 通过 0/1/1 | 通过 0 | 通过 1 | 通过 1 | 页头有保存按钮 |
| `chrome.toolbar.present` | 通过 1/0/0 | 通过 1 | 通过 0 | 通过 0 | 功能区、工具栏与命令都在 |
| `chrome.footer.present` | 通过 0/0/0 | 通过 0 | 通过 0 | 通过 0 | 底栏有网格线开关 |
| `context-menu.cell.present` | 通过 73/83/98 | 通过 86 | 通过 95 | 通过 96 | 两帧之后页面上有单元格的右键菜单（"选择性复制"），显示出来，按 Escape 关掉 |
| `context-menu.sheet-tab.present` | 通过 108/110/107 | 通过 108 | 通过 118 | 通过 144 | 两帧之后页面上有工作表标签的右键菜单（"重命名"），显示出来，按 Escape 关掉 |
| `shortcut.find` | 通过 63/65/63 | 通过 77 | 通过 63 | 通过 62 | 执行完 ui.operation.open-find-dialog，查找面板出现并关掉 |
| `content.unchanged` | 通过 2/2/2 | 通过 2 | 通过 2 | 通过 2 | 内存里的内容与打开时相同（界面检查没有改动文档） |

## 三、与 Playwright 的 WebKit 的差异

- **结论没有差异**：53 项在 Safari 27.0 与 WebKit 26.6（以及 Chromium、Chrome）上结论相同，等到的信号相同（同一条命令被取消、被拦下、执行完），提示的说法相同。
- **用时同一个量级**：被权限检查拦下的入口约 200 毫秒（主要是提示的弹出与淡出），Facade 直接取消的 1–6 毫秒，右键菜单弹出到关掉约 70–110 毫秒，Safari 与 WebKit 相差在十几毫秒以内；`read-only` 一个场景 7 秒左右（含 42 项与之间的点选），编辑器从入口页到 steady 约 3 秒。
- **出错的说法不同**：`facade.新增工作表` 的调用错误在 WebKit 系是 `undefined is not an object (evaluating …)`，Chromium 系是 `Cannot read properties of undefined`——这是调用方接住的预期错误（与 E2E 相同），不影响结论。
- **环境不同**：Playwright 的无头页面总是可见的；真实 Safari 的页面要看得见才跑得动（§四 F1）。

## 四、发现

| 编号 | 类别 | 现象 | 证据 | 处理 |
|---|---|---|---|---|
| F1 | 环境（对产品有影响，交主会话） | **Safari 暂停隐藏的页面**：Safari 的窗口不在前面（被别的窗口挡住、不是当前的应用）时，`open -g` 打开的标签页一开始就是 `hidden`；动画帧一帧都没有，`setInterval(1000)` 跑了 6 次之后停止；窗口带到前台之后页面恢复。隐藏期间编辑器照样走到了 steady（第 2 次），但弹出、关掉对话框与右键菜单这些要动画帧的操作卡住，几秒之后连计时器也停了 | 可见性探针（§2.1）；第 1、2 次的后端日志与交回的结果 | 自检：驱动脚本加 `--front`；页面一开始就隐藏、2 秒之后仍隐藏时，挂接不等 steady，直接交回"页面在后台"（`page.state = 'hidden'`）；中途被隐藏时余下的检查不做、立即交回。**对产品**：编辑租约的心跳（10 秒一次，M3-P1）在隐藏的 Safari 页面里约 6 秒之后就停了，租约 90 秒之后到期（回到前台时由 P1 的续上处理）；P4 的自动保存与捕获时机（DEF-003 的另一半）要按"隐藏之后只有几秒"设计（例如 `visibilitychange` 变成 hidden 时立即保存、`pagehide` 时尽力）；P2 阅读者的定时检查已按"页面隐藏时暂停、回到前台立即读一次"设计。没有改产品代码 |
| F2 | 只读 | 没有发现缺口：53 项全部通过，只读的界面、入口守卫、只读守卫、防火墙与 SDK 的权限检查在 Safari 上的表现与 WebKit 相同 | §二 | — |

## 五、盲区

- **可信的输入**：合成事件不是可信的输入，浏览器不给它们默认行为。键入文字与输入法、粘贴与剪切（浏览器的 `paste`、`cut` 事件与真实剪贴板）、鼠标的拖动（填充柄、行高、冻结线、冻结区域的行高、图片、工作表标签的长按拖动）、双击标签改名、批注浮层里的输入、编辑栏的点击都不在自检里，由 Playwright 的 WebKit 覆盖（`read-only.spec.ts`、`read-only-shortcuts.spec.ts`，设计 §3.5 第 4 条）。快捷键只按了有专门预期的 10 种组合（全部已注册的快捷键的逐个回归在 `read-only-shortcuts.spec.ts`）。
- **Worker 作用域**：公式 Worker 里的错误与 CSP 违规页面上看不到（与 M0 相同）；只核对了 Worker 算出的结果。
- **底栏的两个按钮**：新增工作表与"全部工作表"的按钮没有可访问的名称，只能按 SDK 的 DOM 标记找；自检不写 SDK 的 DOM 标记（lint 只许 internal-api 写、要登记），这两项留给 `read-only.spec.ts`。
- **"还能读"只覆盖了查找**：复制（要读剪贴板）、悬停看批注、切换工作表以外的阅读动作没有放进自检。
- **能编辑时的对照只覆盖界面**：Facade 入口在能编辑时"确实改动"的对照组在 `read-only.spec.ts`（每项一份新文档）；自检在只读时等的是正面的信号（被取消、被拦下），调用没有到达 SDK 时那一项不会空过。
- **只跑了一份样本、一种窗口大小、本机的一个 Safari 版本**；每次运行三个场景各一遍。
- **`edit-chrome` 以"能编辑的人打开即编辑"为前提**（P1 的行为）：S4 改成"打开即阅读"之后，S5 加进入、退出编辑的场景时，这个对照要先点"编辑"。

## 六、怎么重跑

```sh
pnpm db:up
pnpm --filter @nerve-office/e2e run safari:selftest              # open -g，Safari 的窗口要露在前面
pnpm --filter @nerve-office/e2e run safari:selftest --front      # 把 Safari 带到前台（--timeout 秒：总时限，默认 900）
```

- 命令会先构建后端与测试构建；结果在 `tests/e2e/test-results/safari/<时间>.json`（下一次 `pnpm test:e2e` 会清空 `test-results/`，要留存的先拷出来）；
- 与 `pnpm test:e2e` 共用服务日志与控制文件，不要在同一个检出里同时跑；
- 结果里 `page.state` 是 `hidden`、或者可见性里出现 `hidden` 时，把 Safari 的窗口露出来（或者加 `--front`）再跑；
- Safari 里会留下停在结束页的标签页（与 M0 相同），这次复核留下了几个（含第 1、2 次卡住的编辑器页与探针页），可以关掉。

## 七、给后面的步骤

- **S5**：场景在 `SELFTEST_SCENARIOS` 与 `selftest.ts` 的 `SCENARIOS` 里登记，`selftest.spec.ts` 按清单在 Playwright 的浏览器里逐个跑，驱动脚本的步骤在 `support/selftest-plan.ts` 的 `selftestSteps`。进入、退出编辑的场景要等页面的状态变化：挂接只用了编辑器页的 `view().load`（kind、stage、readOnly），S4 改了页面的状态之后在挂接里接上；
- **P4**：捕获时机的复核复用同一套（入口页、挂接、结果的交回、驱动脚本）；按 F1 设计自动保存与捕获在隐藏时的行为，并在真实 Safari 上复核"隐藏之后几秒内存下"。
