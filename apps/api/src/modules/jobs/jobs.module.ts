import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/index.ts'
import { DocumentsModule } from '../documents/index.ts'
import { Clock, DatabaseClock } from './clock.ts'
import { TrashPurgeJob } from './trash-purge.job.ts'
import { TrashPurgeScheduler } from './trash-purge.scheduler.ts'

/**
 * 应用自己的定时任务（M2-P4 设计 §3.1、§3.4 第 6 条）：只做"按时触发 + 防重复执行"，
 * 具体的语义都在各自的模块里——回收站的清理调 documents 导出的 TrashPurgeService。
 * 不引入调度框架，也没有自己的表。
 */
@Module({
  imports: [DatabaseModule, DocumentsModule],
  providers: [
    // 每一轮的"现在"取数据库的时间（M2-P6 复核 A 的疑点 Q-1）；测试换成可控的时钟
    { provide: Clock, useClass: DatabaseClock },
    TrashPurgeJob,
    TrashPurgeScheduler,
  ],
  // 集成测试经 app 层的程序接口取 TrashPurgeJob，用给定的时刻跑一轮（不必等 30 天）
  exports: [TrashPurgeJob],
})
export class JobsModule {}
