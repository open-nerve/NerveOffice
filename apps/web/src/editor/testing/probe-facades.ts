// 探针补上的插件 Facade（M2-P3 S3，只在测试构建里，随 e2e-probe.ts 的分块加载）：M0 的 Facade 入口用到、编辑器自己没有引用的
// （sheet-editor.ts 只引用 sheets 与 sheets-ui 的 Facade）。
// 这些模块不注册插件与服务，只往 Facade 的类上加方法（FBase.extend；已有的成员一个都不替换），另外带两种初始化钩子：
// - 给 FUniver 的（数据验证、图片、筛选、超链接、批注、排序）：只在创建 FUniver 时执行。探针在就绪之后才加载，已有的 univerAPI
//   上不会多出事件的订阅；
// - 给 FWorkbook 的一个（数据验证的 Facade，1.0.1 的 lib/es/facade.js:1578-1582）：之后每次创建 FWorkbook 时执行，只定义一个惰性的
//   getter（_dataValidationModel，读到时才取数据验证的模型），不订阅、不改模型（M2-P6 复核 F6）。
// 所以编辑器的行为不变，只是 E2E 能调用这些方法。
// 这个模块有副作用（加载即改动 Facade 的类）：只能随探针经动态 import() 加载，静态引入会把它带进生产构建（lint 拦下，M2-P6 复核 F5）
import '@univerjs/sheets-conditional-formatting/facade'
import '@univerjs/sheets-data-validation/facade'
import '@univerjs/sheets-drawing/facade'
import '@univerjs/sheets-filter/facade'
import '@univerjs/sheets-find-replace/facade'
import '@univerjs/sheets-hyper-link/facade'
import '@univerjs/sheets-note/facade'
import '@univerjs/sheets-sort/facade'
