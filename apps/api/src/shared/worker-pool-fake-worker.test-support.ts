import { handleFakeTask } from './worker-pool-fakes.test-support.ts'
// 测试用的工作线程入口：执行假任务（worker-pool-fakes.test-support.ts）
import { serveWorkerTasks } from './worker-task.ts'

serveWorkerTasks(handleFakeTask)
