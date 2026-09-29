// 探针补上的插件 Facade（M2-P3 S3，只在测试构建里，随 e2e-probe.ts 的分块加载）：M0 的 Facade 入口用到、编辑器自己没有引用的
// （sheet-editor.ts 只引用 sheets 与 sheets-ui 的 Facade）。
// 这些模块只把方法加到 Facade 的类上（FBase.extend），不注册插件与服务；它们给 FUniver 的初始化钩子只在创建 FUniver 时执行，
// 就绪之后才加载，已有的 univerAPI 上不会多出事件的订阅。所以编辑器的行为不变，只是 E2E 能调用这些方法
import '@univerjs/sheets-conditional-formatting/facade'
import '@univerjs/sheets-data-validation/facade'
import '@univerjs/sheets-drawing/facade'
import '@univerjs/sheets-filter/facade'
import '@univerjs/sheets-find-replace/facade'
import '@univerjs/sheets-hyper-link/facade'
import '@univerjs/sheets-note/facade'
import '@univerjs/sheets-sort/facade'
