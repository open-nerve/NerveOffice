// 测试用的子进程入口：执行假任务（process-pool-fakes.test-support.ts）
import { handleFakeTask } from './process-pool-fakes.test-support.ts'
import { serveProcessTasks } from './process-task.ts'

serveProcessTasks(handleFakeTask)
