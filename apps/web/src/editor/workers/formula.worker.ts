// 公式 Worker 的入口（P4 设计 §3.6.4）：主线程以模块 Worker 创建它（同源脚本，不内联成 blob：CSP 的 worker-src 'self'）。
// 插件组合与官方 Worker preset 相同；工作簿副本由主线程经 RPC 创建，所以这里的生命周期要等主线程创建工作簿之后才到 Ready
// （core 的 univer.ts:202-238）。到 Ready 后装上 IMAGE() 的限制，在同一个 Worker 上回报结果：
// 主线程收到 ok 才算编辑器就绪，这个回报也顺带证明 Worker 已经启动、收到了工作簿（P4 设计 §3.6.7）。
// 不引用 contracts 与 zod（Worker 里没有 zod 的 JIT 关闭）
import { LifecycleStages, LocaleType, LogLevel, Univer } from '@univerjs/core'
import { installRestrictedImageFunction } from '../image-function/install-image-policy.ts'
import { imagePolicyReport } from '../image-function/worker-report.ts'
import { injectorOf, LifecycleService } from '../internal-api/index.ts'
import { formulaWorkerPluginEntries } from '../profile/formula-worker-profile.ts'

const univer = new Univer({ locale: LocaleType.ZH_CN, logLevel: LogLevel.WARN })
for (const entry of formulaWorkerPluginEntries())
  entry.register(univer)

async function installImagePolicy(): Promise<boolean> {
  try {
    // Worker 里没有 Facade：生命周期经 LifecycleService 取得（内部 API，登记在 internal-api/registry.ts）
    await injectorOf(univer).get(LifecycleService).onStage(LifecycleStages.Ready)
    return await installRestrictedImageFunction(univer, globalThis.location.origin)
  }
  catch {
    // 生命周期到不了 Ready（实例被销毁）或安装出错：回报失败，主线程按加载失败处理
    return false
  }
}

void installImagePolicy().then(ok => globalThis.postMessage(imagePolicyReport(ok)))
