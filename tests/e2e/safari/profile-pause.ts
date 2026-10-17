import type { ProfilePageTarget } from './profile-process.ts'
import { z } from 'zod'

export const PROFILE_PAUSE_MAX_MS = 180_000
export const PROFILE_PAUSE_READY_MS = 10_000
const integer = z.number().int().nonnegative().safe()
const positive = integer.positive()
const monotonic = z.number().finite().nonnegative()
const birth = z.string().regex(/^\d{10,20}$/)
const kernel = z.object({ pid: positive, uid: integer, ppid: integer, startedAtUs: birth, executable: z.string().min(1) }).strict()
const reason = z.enum(['requested', 'deadline', 'controller-eof', 'controller-signal', 'user-activity', 'screen-locked', 'desktop-unavailable', 'clock-changed', 'invalid-command', 'output-unavailable', 'target-exited', 'target-changed', 'externally-resumed', 'stop-unconfirmed', 'resume-unconfirmed', 'initial-refused'])
const ready = z.object({ kind: z.literal('ready'), guardian: z.object({ pid: positive, uid: integer, startedAtUs: birth }).strict(), at: positive, monoMs: monotonic }).strict()
const stopped = z.object({ kind: z.literal('stopped'), target: kernel, signalAt: positive, signalMonoMs: monotonic, at: positive, monoMs: monotonic, stopSignals: z.literal(1), maxPauseMs: positive.max(PROFILE_PAUSE_MAX_MS) }).strict()
const finished = z.object({ kind: z.literal('finished'), target: kernel.nullable(), reason, at: positive, monoMs: monotonic, continueAt: positive.nullable(), continueMonoMs: monotonic.nullable(), stopSignals: z.union([z.literal(0), z.literal(1)]), continueSignals: z.union([z.literal(0), z.literal(1)]), stoppedConfirmed: z.boolean(), resumedConfirmed: z.boolean() }).strict()
export const pauseEvent = z.discriminatedUnion('kind', [ready, stopped, finished])
export type PauseEvent = z.infer<typeof pauseEvent>
export type PauseFinished = z.infer<typeof finished>

/** 只核对原生回执，不赋予任意 PID 暂停/恢复资格。任一无效输入使本次证据永久失效。 */
export function createPauseRecord(options: { readonly guardianPid: number, readonly target: ProfilePageTarget, readonly deadline: number }) {
  const events: PauseEvent[] = []
  const problems: string[] = []
  let phase: 'initial' | 'ready' | 'stopped' | 'finished' | 'failed' = 'initial'
  let readyEvent: z.infer<typeof ready> | undefined
  let stopEvent: z.infer<typeof stopped> | undefined
  let finalEvent: PauseFinished | undefined
  const sameTarget = (value: z.infer<typeof kernel>): boolean => ['pid', 'uid', 'startedAtUs', 'executable'].every(key => value[key as keyof typeof value] === options.target[key as keyof ProfilePageTarget])
  function refuse(message: string): false {
    problems.push(message)
    phase = 'failed'
    return false
  }
  function receive(value: unknown): boolean {
    if (phase === 'failed')
      return false
    const parsed = pauseEvent.safeParse(value)
    if (!parsed.success)
      return refuse('原生暂停回执格式无效')
    const event = parsed.data
    if (phase === 'finished')
      return refuse('终态之后仍有回执')
    if (event.kind === 'ready') {
      if (phase !== 'initial' || event.guardian.pid !== options.guardianPid || event.guardian.uid !== options.target.uid || event.guardian.pid === options.target.pid || event.at >= options.deadline)
        return refuse('守护者身份或就绪顺序不符')
      readyEvent = event
      phase = 'ready'
    }
    else if (readyEvent === undefined) {
      return refuse('守护者尚未就绪')
    }
    else if (event.kind === 'stopped') {
      if (phase !== 'ready' || !sameTarget(event.target) || event.signalAt < options.target.observedAt || event.signalAt - options.target.observedAt > 2000 || event.signalAt >= options.deadline
        || event.signalAt < readyEvent.at || event.at < event.signalAt || event.signalMonoMs < readyEvent.monoMs || event.monoMs < event.signalMonoMs || event.signalMonoMs - readyEvent.monoMs > PROFILE_PAUSE_READY_MS) {
        return refuse('暂停身份、新鲜度或时序不符')
      }
      stopEvent = event
      phase = 'stopped'
    }
    else {
      const previous = stopEvent ?? readyEvent
      if (event.monoMs < previous.monoMs || (event.reason !== 'clock-changed' && event.at < previous.at))
        return refuse('恢复回执时钟顺序不符')
      if (event.stopSignals === 0) {
        if (phase !== 'ready' || event.target !== null || event.continueSignals !== 0 || event.stoppedConfirmed || event.resumedConfirmed || event.reason === 'requested')
          return refuse('未暂停的目标出现恢复声明')
      }
      else {
        if (event.target === null || !sameTarget(event.target) || (stopEvent !== undefined && event.target.ppid !== stopEvent.target.ppid))
          return refuse('恢复目标出生身份或父进程改变')
        if (stopEvent === undefined ? event.stoppedConfirmed || event.reason !== 'stop-unconfirmed' : !event.stoppedConfirmed)
          return refuse('缺少内核停止确认')
      }
      if (event.continueSignals === 0) {
        if (event.continueAt !== null || event.continueMonoMs !== null || event.resumedConfirmed)
          return refuse('没有 CONT 却声明恢复')
      }
      else if (event.stopSignals !== 1 || event.continueAt === null || event.continueMonoMs === null || event.continueMonoMs < previous.monoMs || event.continueMonoMs > event.monoMs || (event.reason !== 'clock-changed' && (event.continueAt < previous.at || event.continueAt > event.at))) {
        return refuse('CONT 身份或时序不符')
      }
      if (event.reason === 'requested' && (stopEvent === undefined || event.continueSignals !== 1 || !event.resumedConfirmed || event.monoMs - stopEvent.signalMonoMs > stopEvent.maxPauseMs + 2000))
        return refuse('正常完成缺少有效恢复或超过期限')
      finalEvent = event
      phase = 'finished'
    }
    events.push(structuredClone(event))
    return true
  }
  return {
    receive,
    snapshot: () => ({ phase, events: structuredClone(events), problems: [...problems], restored: phase === 'finished' && finalEvent?.resumedConfirmed === true && finalEvent.continueSignals === 1, normalCompletion: phase === 'finished' && finalEvent?.reason === 'requested' }),
  }
}
