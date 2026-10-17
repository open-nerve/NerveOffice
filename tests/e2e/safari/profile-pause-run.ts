// 宿主只协调归属与阶段。真正的桌面监测、内核 STOP/CONT 和失联恢复由独立原生守护完成。
import type { PauseEvent, PauseFinished } from './profile-pause.ts'
import type { ProfilePageContext, ProfilePageSnapshot, ProfilePageTarget } from './profile-process.ts'
import { identifyProfilePage, revalidateProfilePage } from './profile-process.ts'

type Ready = Extract<PauseEvent, { kind: 'ready' }>
type Stopped = Extract<PauseEvent, { kind: 'stopped' }>
interface Guardian {
  readonly ready: Promise<Ready>
  readonly finished: Promise<PauseFinished>
  readonly stop: (context: ProfilePageContext, target: ProfilePageTarget) => Promise<Stopped>
  readonly resume: () => void
  readonly close: () => void
}

export function createProfilePauseRun(context: ProfilePageContext, dependencies: { readonly capture: () => ProfilePageSnapshot, readonly now: () => number, readonly start: () => Guardian }) {
  let begun = false
  let attempted = false
  let inProgress = false
  let resuming = false
  let guardian: Guardian | undefined
  let before: ProfilePageSnapshot | undefined
  let second: ProfilePageSnapshot | undefined
  let ready: Ready | undefined
  let stopped: Stopped | undefined
  let finished: PauseFinished | undefined
  let target: ProfilePageTarget | undefined
  let cleanupFailed = false
  const capture = (): ProfilePageSnapshot => {
    if (inProgress)
      throw new Error('暂停期间不能用 Apple Events 查询页面')
    return dependencies.capture()
  }
  const accept = (value: PauseFinished): PauseFinished => {
    finished = value
    // 不能把未知恢复或异常退出当成可以再查询的运行中页面。
    if (value.stopSignals === 0 || value.resumedConfirmed)
      inProgress = false
    return value
  }
  const settle = async (): Promise<PauseFinished | undefined> => {
    if (guardian === undefined)
      return undefined
    try {
      guardian.close()
      return accept(await guardian.finished)
    }
    catch (error) {
      cleanupFailed = true
      throw error
    }
  }
  return {
    capture,
    async stop(): Promise<Stopped> {
      if (begun)
        throw new Error('本轮只能尝试一次暂停')
      begun = true
      before = capture()
      const first = identifyProfilePage(context, before, dependencies.now())
      if (first.kind !== 'identified')
        throw new Error(first.reason)
      target = first.target
      try {
        guardian = dependencies.start()
        void guardian.finished.then(accept, () => {})
        ready = await guardian.ready
        second = capture()
        const next = revalidateProfilePage(target, context, second, dependencies.now())
        if (next.kind !== 'identified')
          throw new Error(next.reason)
        target = next.target
        attempted = true
        inProgress = true
        stopped = await guardian.stop(context, target)
        if (finished !== undefined)
          throw new Error('暂停确认之前守护者已经结束')
        return stopped
      }
      catch (error) {
        // 保留首个拒绝；清理失败另有明确字段，并且仍禁止对不明状态的目标做页面查询。
        await settle().catch(() => {})
        throw error
      }
    },
    async resume(): Promise<PauseFinished> {
      if (guardian === undefined || stopped === undefined || finished !== undefined || !inProgress || resuming)
        throw new Error('没有可恢复的本轮暂停或已请求恢复')
      resuming = true
      guardian.resume()
      return accept(await guardian.finished)
    },
    settle,
    snapshot: () => structuredClone({ begun, attempted, inProgress, resuming, before, second, ready, stopped, finished, target, cleanupFailed }),
  }
}
