# 剪贴板样本（P5，V13 复制粘贴）

用于合成粘贴（`e2e/p4-helpers.ts` 的 `syntheticPaste`），作为剪贴板里的 `text/html`。

这些样本**不是真实截取**，而是按各来源剪贴板 HTML 的真实结构编写的，用来覆盖转换器的各条分支。用真实应用、真实剪贴板复核，登记为延期项（见 P5 报告）。

| 文件 | 来源特征 | 覆盖的要点 |
|---|---|---|
| `word-win.html` | Word 2016+（Windows）：`xmlns:o`/`xmlns:w`，`Generator: Microsoft Word 15`，`mso-*` 样式，`<!--StartFragment-->` | `<h1>`/`<h2>`；粗斜体、下划线、删除线、上下标、颜色、`mso-highlight` 高亮、字号与字体；居中、右对齐；`mso-list` 编号与多级、Wingdings 项目符号；`MsoTableGrid` 表格（`windowtext` 边框、底色）；网址与邮件链接；`10.5pt` 字号 |
| `word-mac.html` | Word for Mac：`Generator: Microsoft Word 16`，`file:////Users/…` | `MsoTitle` 标题（不是 `<h1>`）；`<h3>`；中文编号（`一、`、`（一）`）；`§` 项目符号；段内换行 `<br>`；固定行距 `20pt`；`file:` 图片 |
| `wps.html` | WPS：伪装为 `Microsoft Word 14`，`ksohtml` 临时路径，`<font face>` | 标题是带 `mso-outline-level:1` 的 `p.MsoHeading1`；`mso-list` 编号；`MsoNormalTable`；`text-decoration:underline` |
| `web-article.html` | Chrome 复制的网页（GitHub 风格）：`<meta charset='utf-8'>`，每个元素带计算后的内联样式（含 `word-spacing`） | `<h1>`/`<h2>`/`<h6>`；`<strong>`/`<em>`/`<code>`/`<del>`；嵌套的有序、无序列表；`<blockquote>`；`<th>` 表头；`<br>`；`<pre>` |
| `web-news.html` | Safari 复制的中文新闻页：`<meta charset="UTF-8">`，`Apple-converted-space` | `div` 段落、首行缩进 `2em`、`<font color>`、`px` 字号、`<br>` 分行、外链图片 |
| `google-docs.html` | Google Docs：`<b id="docs-internal-guid-…" style="font-weight:normal">` 包住全部内容 | `font-weight:400/700`、斜体、下划线、`aria-level` 列表、`colgroup` 表格、链接 |
| `feishu.html` | 飞书：`lark-record-clipboard` 标记，`div.ace-line` | 标题、删除线、编号与项目符号列表、高亮、链接 |
| `malicious.html` | 恶意网页 | `<script>`、`<style>`、`javascript:`（含大小写混合）、`data:`、`vbscript:` 链接，`onclick`/`onmouseover`/`onerror`，`<iframe>`、`<svg>`；本站相对地址与锚点 |

内部片段（`<!--univer-doc-fragment:…-->`）与纯文本在用例里构造。
