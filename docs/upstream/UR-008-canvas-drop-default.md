# UR-008 画布接受拖入却不处理、也不阻止 drop 的默认行为，拖入图片文件时由浏览器打开文件

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue
> 出处：M0-P4 报告摘要"SDK 的几处可用性缺口"、§3.2"功能降级"表的"拖放图片文件"一行、§3.3 第 4 条、§3.4（M5 宿主拦截 `drop`）；用例 `spikes/m0/e2e/v12-degradation.spec.ts`（第 5 步"拖放文件"，结果 `spikes/m0/e2e/results/v12/degradation/*.json`）；P4 交接单"上游报告"第 3 条；真实拖放的复核是 DEF-004｜发现版本：1.0.0｜1.0.1 核对：仍然存在（依据：已安装的 `@univerjs/engine-render@1.0.1` 发布包 `lib/es/index.js` 中，`_dragOverEvent` 第一句仍是 `evt.preventDefault()`，`_dropEvent` 仍只转发事件、不阻止默认行为（L35279–35322）；另在 1.0.1 上用不含平台代码的最小页面实测：合成事件与经 DevTools 协议走浏览器真实拖放流程两种方式都复现，见正文；npm 上的 1.0.2（当前 latest）代码相同）

## 摘要（中文）

渲染引擎在画布上对 `dragover` 调用了 `preventDefault()`（注释写着"prevent default to allow drop"），等于告诉浏览器"这里可以放下"；但 `drop` 的监听只把事件转发给场景，既不处理拖进来的文件，也不阻止浏览器的默认行为。用户把桌面上的图片拖到表格上时，Univer 什么都不插入，浏览器却执行它对文件的默认动作：1.0.1 上经浏览器真实拖放流程测到 Chromium 新开一个标签页（无头模式下读不到这个标签页载入的地址；宿主自己对 `drop` 调用 `preventDefault()` 时不再新开）；有的浏览器可能直接在当前标签页打开文件、离开编辑页（M0 的判断，Safari 与 Firefox 未验证）。Facade 虽然有 `univerAPI.Event.Drop`，但参数里没有原生事件，集成方经 Facade 拿到文件也拦不住默认行为。对平台的影响：用户以为能拖图进表格，结果被带到一个新标签页，或者（未验证的浏览器上）离开编辑页。平台的规避：M1 没有处理拖放，只有编辑器页的"有未保存修改时离开页面先提示"（`beforeunload`，M1-P4 设计 §3.7.3）兜底；M5 计划在编辑器容器上拦截 `drop`，阻止默认行为并把图片交给平台图片服务插入（P4 报告 §3.3 第 4 条）。待补充：StackBlitz 复现链接、`npx envinfo` 输出、真实操作系统拖放在 Chrome、Safari、Firefox 里的表现（DEF-004）。

## 已有的上游讨论

没有找到（2026-09-28 检索 GitHub 的 issue 与 PR，关键词：`drop file`、`dragover`、`drag image`、`drop preventDefault`、`"drag and drop" image`；另用 WebSearch 检索网页）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] Canvas prevents `dragover` but never handles or prevents `drop`: a dropped image file is not inserted, and the browser opens the file instead

### Describe the bug

`Engine` registers `dragover` and `drop` listeners on the canvas. The `dragover` listener calls `preventDefault()` ("prevent default to allow drop"), so the canvas declares itself a drop target, but the `drop` listener only forwards the event to the scene and never calls `preventDefault()`. Univer itself does not handle dropped data (the scene input manager says drag events are "for 3rd users").

So when a user drags an image file from the desktop onto a sheet, nothing is inserted, and the browser then performs its default action for a dropped file. In Chromium we observed a new tab being opened for the file; browsers that open a dropped file in the current tab would navigate away from the editor.

The sheets Facade exposes `univerAPI.Event.Drop` with the `dataTransfer`, but not the native event, so an integrator who handles files through the Facade still cannot stop the browser's default action; a separate DOM listener on the container is needed.

### To reproduce

Reproduction link: _to be added (StackBlitz)_. Only public APIs are used.

1. Set up a sheet with the sheets core preset (1.0.1); the sheets drawing preset may be added, it makes no difference:

   ```ts
   import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
   import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
   import SheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
   import '@univerjs/preset-sheets-core/lib/index.css';

   const { univerAPI } = createUniver({
       locale: LocaleType.EN_US,
       locales: { [LocaleType.EN_US]: mergeLocales(SheetsCoreEnUS) },
       presets: [UniverSheetsCorePreset({ container: 'app' })],
   });
   univerAPI.createWorkbook({});
   ```

2. Manually: drag a PNG file from the desktop and drop it on a cell. Nothing is inserted into the sheet, and the browser performs its default action for the dropped file (in our Chromium run through the real drag-and-drop pipeline: a new tab is opened for the file).
3. Deterministic check of the event handling, in the DevTools console:

   ```js
   const canvas = document.querySelector('canvas[id^="univer-sheet-main-canvas"]');
   const rect = canvas.getBoundingClientRect();
   const dt = new DataTransfer();
   dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' }));
   const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.left + 200, clientY: rect.top + 200 };
   const over = new DragEvent('dragover', init);
   canvas.dispatchEvent(over);
   const drop = new DragEvent('drop', init);
   canvas.dispatchEvent(drop);
   console.log({ dragoverPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented });
   // → { dragoverPrevented: true, dropPrevented: false }
   ```

   (Synthetic events do not trigger the browser's default action; they only show how Univer handles the two events.)

### Expected behavior

Either the canvas does not accept drops it does not handle (no `preventDefault()` on `dragover`), or — since it does accept them — it calls `preventDefault()` on `drop`, so the browser never opens the file and the user never leaves the editor. Ideally a dropped image file is inserted like a pasted image file (a floating image in sheets, an image in docs). Integrators using `univerAPI.Event.Drop` should be able to take over the drop, e.g. through the native event in the event params.

### Actual behavior

On 1.0.1:

| Check | Chromium 153 | WebKit 26.6 |
|---|---|---|
| synthetic `dragover` on the canvas: `defaultPrevented` | `true` | `true` |
| synthetic `drop` with one PNG file: `defaultPrevented` | `false` | `false` |
| floating images inserted | 0 | 0 |
| real drag-and-drop pipeline (DevTools protocol `Input.dispatchDragEvent`, one PNG file): the `drop` reaches the canvas with the file, is not default-prevented, nothing is inserted, and **the browser opens a new tab** | yes | not available |
| same, but the host page calls `preventDefault()` in its own `drop` listener | no new tab | not available |

The new tab is the browser's default action for the dropped file; in headless mode we could not read which URL it loaded. On 1.0.0 the synthetic-event check gave the same result in Chromium, Chrome and WebKit. We could not drive a real operating-system drag in Safari or Firefox, so we have not verified whether they open the dropped file in the current tab.

### Root cause analysis

Line numbers refer to the `v1.0.0` tag; the code is unchanged in the published 1.0.1 and 1.0.2 packages.

- `packages/engine-render/src/engine.ts` `_handleDragAction()` (L866–967):
  - L889–891: the `dragover` handler starts with `// prevent default to allow drop` followed by `evt.preventDefault();`.
  - L951–960: the `drop` handler only sets `deviceType` / `currentState` and emits `onInputChanged$`; it never calls `preventDefault()`.
  - L962–966: both listeners are attached to the canvas element, so this applies to every unit type that renders through `Engine`.
- `packages/engine-render/src/scene.input-manager.ts` L355: "Drag Events, For 3rd users. Univer itself doesn't use drag events."; L378–379 forwards `drop` to `scene.onDrop$`.
- Sheets: `DragManagerService.onDrop()` (`packages/sheets-ui/src/services/drag-manager.service.ts` L107–125) and the Facade `Drop` event (`packages/sheets-ui/src/facade/f-univer.ts` L560–582) pass `dataTransfer`, row and column along; `IDragEventParams` (`packages/sheets-ui/src/facade/f-event.ts` L207–208) does not include the native event, so a Facade listener cannot call `preventDefault()`.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); first observed on 1.0.0; the code above is unchanged in 1.0.2 (latest on npm on 2026-09-28).
- Affected packages: `@univerjs/engine-render` (`Engine` drag listeners), `@univerjs/sheets-ui` (Facade drag events).
- Browsers: Chromium 153.0.8010.12 (Playwright build), WebKit 26.6 (Playwright build), headless via Playwright 1.63.0; on 1.0.0 also Google Chrome 153.0.8010.53. Real OS drag-and-drop in Chrome, Safari and Firefox not tested.
- OS: macOS 27.0 for the 1.0.1 runs, macOS 26.5.1 for the 1.0.0 runs (Apple M4 Pro).

### Suggested fix

1. In `Engine`'s `drop` handler (engine.ts L951–960), call `evt.preventDefault()`: the canvas already accepted the drag in `dragover`. Alternatively, only accept drops (prevent `dragover`) when something is registered to handle them.
2. Handle dropped image files the same way as pasted image files (through `IImageIoService`: a floating image in sheets, an image in docs), or document that hosts must handle `drop` themselves.
3. Include the native event (or a `preventDefault()` hook) in the Facade `DragOver` / `Drop` event params, so integrators using `univerAPI.Event.Drop` can take over the drop.
