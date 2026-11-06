// M5-P7 Q-08：`docker compose up -d` 升级时，旧 app 停止与 migrate 启动的先后（deploy/README.md 的“升级”第 3 步）。
// 只解析 docker events 的 JSON 行（--format '{{json .}}'）里的类型、动作、容器、compose 服务名、退出码与时间；不读环境变量与日志
import { z } from 'zod'

const eventSchema = z.object({
  Type: z.string(),
  Action: z.string(),
  Actor: z.object({ ID: z.string(), Attributes: z.record(z.string(), z.string()).optional() }),
  timeNano: z.number(),
})

/** 容器的一次生命周期事件；时间是距纪元的毫秒（timeNano 超出安全整数，只用于排序与毫秒级间隔） */
export interface ContainerEvent {
  readonly atMs: number
  readonly action: string
  readonly container: string
  readonly service: string | undefined
  readonly exitCode: string | undefined
  /** kill 事件的信号编号（15 为 SIGTERM） */
  readonly signal: string | undefined
}

/** 健康检查的 exec_* 与 health_status 也是容器事件，不参与判定 */
const LIFECYCLE = new Set(['create', 'start', 'kill', 'die', 'stop', 'destroy', 'rename'])

export function parseContainerEvents(output: string): ContainerEvent[] {
  const parsed = output.split('\n').filter(line => line.trim() !== '').map(line => eventSchema.parse(JSON.parse(line)))
  const lifecycle = parsed.filter(event => event.Type === 'container' && LIFECYCLE.has(event.Action))
  return lifecycle.map(event => ({
    atMs: event.timeNano / 1e6,
    action: event.Action,
    container: event.Actor.ID,
    service: event.Actor.Attributes?.['com.docker.compose.service'],
    exitCode: event.Actor.Attributes?.exitCode,
    signal: event.Actor.Attributes?.signal,
  })).sort((a, b) => a.atMs - b.atMs)
}

export type UpgradeVerdict = 'old-app-stopped-before-migrate' | 'migrate-started-while-old-app-running' | 'incomplete'

export interface UpgradeOrder {
  readonly verdict: UpgradeVerdict
  /** 以下均为距第一条事件的毫秒 */
  readonly oldAppDiedMs: number | undefined
  readonly migrateStartedMs: number | undefined
  readonly migrateExitCode: string | undefined
  readonly newAppStartedMs: number | undefined
  /** 按时间排列的生命周期事件；容器只标旧 app / 新容器，不带 ID */
  readonly timeline: readonly { readonly ms: number, readonly service: string, readonly role: 'old-app' | 'other', readonly action: string, readonly exitCode?: string, readonly signal?: string }[]
}

/** 旧 app 的进程退出（die）早于新 migrate 启动（start），才与“先停掉旧的应用……然后执行迁移”一致 */
export function upgradeOrder(events: readonly ContainerEvent[], oldApp: string): UpgradeOrder {
  const origin = events[0]?.atMs ?? 0
  const relative = (event: ContainerEvent | undefined): number | undefined => event === undefined ? undefined : Math.round(event.atMs - origin)
  const oldAppDied = events.find(event => event.container === oldApp && event.action === 'die')
  const migrateStarted = events.find(event => event.service === 'migrate' && event.action === 'start')
  const migrateDied = migrateStarted === undefined ? undefined : events.find(event => event.container === migrateStarted.container && event.action === 'die')
  const newAppStarted = events.find(event => event.service === 'app' && event.container !== oldApp && event.action === 'start')
  const verdict: UpgradeVerdict = oldAppDied === undefined || migrateStarted === undefined || newAppStarted === undefined
    ? 'incomplete'
    : oldAppDied.atMs < migrateStarted.atMs ? 'old-app-stopped-before-migrate' : 'migrate-started-while-old-app-running'
  return {
    verdict,
    oldAppDiedMs: relative(oldAppDied),
    migrateStartedMs: relative(migrateStarted),
    migrateExitCode: migrateDied?.exitCode,
    newAppStartedMs: relative(newAppStarted),
    timeline: events.map(event => ({
      ms: Math.round(event.atMs - origin),
      service: event.service ?? 'unknown',
      role: event.container === oldApp ? 'old-app' : 'other',
      action: event.action,
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    })),
  }
}
