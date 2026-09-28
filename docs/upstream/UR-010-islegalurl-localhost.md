# UR-010 `isLegalUrl` 把以 `http://localhost:5173`／`localhost:5173` 开头的任意字符串当作合法地址（开发遗留）

> 状态：草稿（提交之前需求方确认）｜上游仓库：dream-num/univer｜提交方式：公开 issue（判断过安全影响，不走 SECURITY.md 的私下渠道，理由见摘要）
> 出处：M1-P4 设计 §3.9（S3 产物扫描的地址登记："`isLegalUrl` 里的 `http://localhost:5173`"）、M1-P4 交接单的延期项；延期登记 DEF-019（关联 DEF-021：键入、粘贴网址时的自动识别）；M0-P1 报告 §2.3（编辑器产物中的外部地址："链接识别代码里残留的开发地址判断"）｜发现版本：1.0.0（M0-P1 的产物扫描已见到这个地址，DEF-019 在 1.0.1 上登记）｜1.0.1 核对：仍然存在（依据：已安装的 `@univerjs/core@1.0.1` 发布包 `lib/es/index.js` 中，`isLegalUrl`（L545–558）的第二句仍是 `if (url.startsWith("http://localhost:5173") || url.startsWith("localhost:5173")) return true;`（L547）；另在 Node 24 下直接调用 1.0.1 的 `Tools.isLegalUrl`，并在 1.0.1 的最小页面里用 Chromium 键入验证，见正文；npm 上的 1.0.2（当前 latest）同一位置代码相同）

## 摘要（中文）

`@univerjs/core` 的 `isLegalUrl`（即 `Tools.isLegalUrl`）在做正则校验之前，先对以 `http://localhost:5173` 或 `localhost:5173` 开头的字符串直接返回 `true`——这是 SDK 示例开发服务器（端口 5173）留下的判断，单元测试里还断言了它。结果是：任何以这个前缀开头的文字都算"合法地址"，包括带空格、换行、根本解析不了的字符串；在表格里键入 `localhost:5173 is our dev server`，整格会变成一个地址为 `https://localhost:5173 is our dev server` 的超链接，而换成 `localhost:3000` 或 `http://example.com see notes` 都不会。链接编辑框、粘贴纯文本时的网址识别、`HYPERLINK` 公式也用这个函数。**安全判断**：它本身不构成可利用的安全问题，所以走公开 issue：这条捷径只能放行 `http:` 或形如 `localhost:` 的"协议"，放不进 `javascript:`、`data:` 等危险协议；点击链接时 SDK 另用 `isSafeUrl` 只放行 http、https、mailto，这些地址要么 `new URL()` 解析失败、要么协议是 `localhost:`，按源码点击都会被拒；而引号、尖括号之类的字符，正则本身对任何域名都放行，并不是这条捷径带来的。需要注意的是 M0-P5 在超链接上的另两项发现（链接地址的校验、复制时的转义）涉及安全，**不写进这份公开 issue**；它们已另起草为 UR-013、UR-014，走 SECURITY.md 的私下渠道，草稿不进公开仓库。UR-013 的草稿也把这条捷径（DEF-019）写了进去，提交前要统一口径：要么这条捷径只在 UR-010 公开报告、UR-013 里删掉，要么并入 UR-013、不单独提交 UR-010，要么等 UR-013、UR-014 修复发布之后再公开提交 UR-010。对平台的影响：它只是让白名单不能依赖 SDK 的判断（DEF-019）。平台的规避：M1 隐藏了超链接入口、写入链接的命令被守卫拦下，但键入与粘贴时的自动识别仍会写入这类链接（DEF-021，E2E 锁定现状）；点击时 `isSafeUrl` 拦下畸形地址；M3 的快照校验要求链接地址等于规范写法，M5 的链接白名单由平台自己校验协议与地址，不依赖 `isLegalUrl`。待补充：StackBlitz 复现链接、`npx envinfo` 输出。

## 已有的上游讨论

没有找到（2026-09-28 检索 GitHub 的 issue 与 PR，关键词：`isLegalUrl`、`"localhost:5173"`（只找到用户在自己的开发环境里提到这个端口的无关 issue）、`hyperlink url validation`、`legal url link`；另用 WebSearch 检索网页）。

---

## Issue（英文，可以直接提交）

**Title:** [Bug] core: `isLegalUrl()` accepts any string that starts with `http://localhost:5173` or `localhost:5173`, so arbitrary text gets auto-linked with a malformed URL

### Describe the bug

`isLegalUrl()` (exposed as `Tools.isLegalUrl`) returns `true` for any string that *starts with* `http://localhost:5173` or `localhost:5173`, before the URL regex is even consulted. This looks like a leftover shortcut for the examples dev server, which runs on port 5173.

Because of it, text with whitespace, line breaks or trailing words is treated as a valid URL as long as it has that prefix, while the same text with any other host or port is not. For example, typing `localhost:5173 is our dev server` into a cell turns the whole cell into a hyperlink whose URL is `https://localhost:5173 is our dev server` — not a parseable URL. The link dialogs, plain-text paste and the `HYPERLINK` function use the same check.

### To reproduce

Reproduction link: _to be added (StackBlitz)_. Only public APIs are used.

1. Call the function directly (Node or browser):

   ```ts
   import { Tools } from '@univerjs/core';

   Tools.isLegalUrl('localhost:5173 is our dev server');  // true
   Tools.isLegalUrl('http://localhost:5173 see notes');  // true
   Tools.isLegalUrl('localhost:5173\nsecond line');      // true
   Tools.isLegalUrl('http://localhost:5173.example/');   // true, although new URL() throws for it

   Tools.isLegalUrl('localhost:3000 is our dev server');  // false
   Tools.isLegalUrl('http://localhost:3000/');            // false
   Tools.isLegalUrl('http://example.com/a b');            // false
   ```

2. In a sheet with the sheets core and sheets hyperlink presets (1.0.1):

   ```ts
   import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
   import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
   import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link';
   import SheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
   import SheetsHyperLinkEnUS from '@univerjs/preset-sheets-hyper-link/locales/en-US';
   import '@univerjs/preset-sheets-core/lib/index.css';
   import '@univerjs/preset-sheets-hyper-link/lib/index.css';

   const { univerAPI } = createUniver({
       locale: LocaleType.EN_US,
       locales: { [LocaleType.EN_US]: mergeLocales(SheetsCoreEnUS, SheetsHyperLinkEnUS) },
       presets: [UniverSheetsCorePreset({ container: 'app' }), UniverSheetsHyperLinkPreset()],
   });
   univerAPI.createWorkbook({});
   ```

   Select A1, type `localhost:5173 is our dev server` and press Enter; select A2, type `localhost:3000 is our dev server` and press Enter.

### Expected behavior

`isLegalUrl()` validates the whole string the same way for every host and port. If local development URLs should be recognized at all, `http://localhost:<port>/…` should be accepted by the regular grammar (any port, no whitespace), not by a prefix check. Neither A1 nor A2 becomes a link.

### Actual behavior

On 1.0.1, typing into A1–A6 (Chromium 153):

| Typed text | Result |
|---|---|
| `localhost:5173 is our dev server` | whole cell is a link to `https://localhost:5173 is our dev server` (not a parseable URL) |
| `http://localhost:5173 see notes` | whole cell is a link to `http://localhost:5173 see notes` (not a parseable URL) |
| `localhost:3000 is our dev server` | plain text |
| `http://localhost:3000 see notes` | plain text |
| `http://example.com see notes` | plain text |
| `https://example.com/page` | link to `https://example.com/page` (as intended) |

The function calls in step 1 return the values shown in the comments (checked in Node 24.21.0 against the published 1.0.1 package).

### Root cause analysis

Line numbers refer to the `v1.0.0` tag; the code is unchanged in the published 1.0.1 and 1.0.2 packages.

- `packages/core/src/common/url.ts` L326–355 `isLegalUrl()`: L332–334 `if (url.startsWith('http://localhost:5173') || url.startsWith('localhost:5173')) { return true; }` runs before `re_weburl` (L289–325), which would reject whitespace and requires a dotted host name or an IPv4 address.
- `packages/core/src/common/__tests__/url.spec.ts` L24 asserts `isLegalUrl('http://localhost:5173')`; `examples/vite.config.ts` L193–200 runs the dev server on port 5173.
- `Tools.isLegalUrl()` (`packages/core/src/shared/tools.ts` L279–281) is used to decide whether a string becomes a hyperlink or is accepted as one:
  - auto-link on cell edit: `packages/sheets-hyper-link/src/controllers/set-range.controller.ts` L148 (the link URL is `normalizeUrl(text)`, i.e. `https://` is prepended when there is no `scheme://`);
  - plain-text paste: `packages/sheets-ui/src/controllers/clipboard/utils.ts` L533, `packages/sheets-ui/src/controllers/clipboard/clipboard.controller.ts` L574, `packages/core/src/docs/data-model/text-x/build-utils/parse.ts` L65;
  - link dialogs: `packages/sheets-hyper-link-ui/src/common/util.ts` L19–21 (`isLegalLink`, used by `views/CellLinkEdit.tsx` L371 and L482 and `controllers/copy-paste.controller.ts` L76), `packages/docs-hyper-link-ui/src/views/hyper-link-edit/use-doc-hyper-link-edit.ts` L56;
  - `HYPERLINK`: `packages/engine-formula/src/services/hyperlink-engine-formula.service.ts` L66.

### Environment

- Univer: 1.0.1 (`@univerjs/*`); present since at least 1.0.0; the same line is in 1.0.2 (latest on npm on 2026-09-28).
- Affected package: `@univerjs/core` (`isLegalUrl`, `Tools.isLegalUrl`).
- Runtime: Node 24.21.0 (direct calls); Chromium 153.0.8010.12 (Playwright build, headless via Playwright 1.63.0) for the typing test. The function is plain JavaScript, so the result does not depend on the browser.
- OS: macOS 27.0 (Apple M4 Pro).

### Suggested fix

- Remove the prefix shortcut (url.ts L332–334).
- If local development URLs should be recognized, accept `localhost` (and loopback addresses) with any port through the normal validation — e.g. extend `re_weburl`, or parse with `new URL()` and check the host — so that whitespace and trailing text are rejected as for every other host.
- Update `url.spec.ts`: keep `http://localhost:5173/` legal if intended, and add negative cases such as `'localhost:5173 some text'` and `'http://localhost:5173 see notes'`.
