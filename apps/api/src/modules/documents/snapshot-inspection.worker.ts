// 快照检查的工作线程入口（M3-P3 设计 §3.3，DEF-018）：SnapshotInspector 经线程池交来解压之后的字节与档案，
// 这里解码、解析、检查、规范化、算哈希（inspectSnapshot），只把小结果回给主线程；解析出的对象留在线程里回收。
// 由 SnapshotInspector 按自己的扩展名加载：源码运行（单元测试、集成测试）时是这个 .ts，构建产物与镜像里是 .js
import type { InspectionTask, SnapshotInspection } from './snapshot-inspection.ts'
import { serveWorkerTasks } from '../../shared/worker-task.ts'
import { inspectSnapshot } from './snapshot-inspection.ts'

serveWorkerTasks<InspectionTask, SnapshotInspection>(task => inspectSnapshot(task.bytes, task.profile))
