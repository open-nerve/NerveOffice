import type { ProfilePageContext, ProfilePageSnapshot, ProfilePageTarget, ProfileProcessIdentity, SafariProfileProof } from './profile-process.ts'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { hidIdleSeconds, screenLocked } from './desktop.ts'
import { revalidateProfilePage } from './profile-process.ts'

const positive = z.number().int().positive().safe()
const identity = z.object({ pid: positive, uid: z.number().int().nonnegative().safe(), startedAtUs: z.string().regex(/^\d{10,20}$/), executable: z.string(), bundleId: z.string(), asn: z.string(), appleSigned: z.boolean() }).strict()
const windowMap = z.array(z.object({ windowId: positive, profileMatches: z.boolean(), tabs: z.array(z.object({ index: positive, pid: z.number().int().nonnegative().safe(), urlMatches: z.boolean(), knownUrlMatches: z.boolean() }).strict()) }).strict())
const profileProof = z.object({ name: z.string().min(1), windowId: positive, axWindowUuid: z.uuid(), exclusiveFromCreation: z.boolean(), extensionsDisabled: z.boolean(), createdAt: positive, baseline: z.object({ capturedAt: positive, pids: z.array(positive).min(1) }).strict() }).strict()
const signalReceipt = z.object({ kind: z.literal('signaled'), pid: positive, startedAtUs: z.string(), signal: z.literal('SIGKILL'), sentAt: positive, signalsSent: z.literal(1) }).strict()
const checkReceipt = z.object({ kind: z.literal('checked-only'), signalsSent: z.literal(0) }).strict()
export type ProfileSignalReceipt = z.infer<typeof signalReceipt>

// 只读 Safari API，参数经 argv 传递。其他用户的标题和 URL 只参与比较，不输出、不存档。
const TAB_MAP = `function run(args) {
  const app = Application('Safari');
  const known = JSON.parse(args[2]);
  return JSON.stringify(app.windows().map(function(window) {
    return {windowId: window.id(), profileMatches: window.name().startsWith(args[0] + ' — '), tabs: window.tabs().map(function(tab) {
      const url = tab.url();
      return {index: tab.index(), pid: tab.pid(), urlMatches: url === args[1], knownUrlMatches: known.indexOf(url.split('#')[0]) !== -1};
    })};
  }));
}`

export function parseProfileProof(value: unknown): SafariProfileProof {
  return profileProof.parse(value)
}

/** 构建本仓库受审的原生源码；输出路径必须属于本次驱动自己的临时目录。 */
export function compileProfileNative(output: string): void {
  execFileSync('swiftc', [fileURLToPath(new URL('./profile-native.swift', import.meta.url)), '-o', output], { timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function readProfileIdentities(binary: string, pids: readonly number[]): readonly ProfileProcessIdentity[] {
  if (pids.length === 0)
    return []
  return z.array(identity).parse(JSON.parse(execFileSync(binary, ['read', ...pids.map(String)], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 })))
}

export function captureProfilePage(binary: string, context: ProfilePageContext, returned: () => boolean, knownUrls: readonly string[] = [context.url]): ProfilePageSnapshot {
  const capturedAt = Date.now()
  const windows = windowMap.parse(JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', TAB_MAP, context.profile.name, context.url, JSON.stringify(knownUrls)], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 })))
  const pids = [...new Set(windows.flatMap(window => window.tabs.map(tab => tab.pid)).filter(pid => pid > 1))]
  const processes = readProfileIdentities(binary, pids)
  const desktop = { idleSeconds: hidIdleSeconds(), locked: screenLocked(), returned: returned() }
  return { capturedAt, finishedAt: Date.now(), windows, processes, desktop }
}

export function signalProfilePage(binary: string, context: ProfilePageContext, target: ProfilePageTarget): ProfileSignalReceipt {
  const request = { target, mainPid: context.mainPid, observedAt: target.observedAt, deadline: context.deadline }
  const receipt = signalReceipt.parse(JSON.parse(execFileSync(binary, ['signal'], { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000, maxBuffer: 8192 })))
  if (receipt.pid !== target.pid || receipt.startedAtUs !== target.startedAtUs || receipt.sentAt < target.observedAt || receipt.sentAt > Date.now())
    throw new Error('原生单 PID 信号收据与本次目标不符')
  return receipt
}

export function checkProfileSignal(binary: string, context: ProfilePageContext, target: ProfilePageTarget) {
  return checkReceipt.parse(JSON.parse(execFileSync(binary, ['check-signal'], { input: JSON.stringify({ target, mainPid: context.mainPid, observedAt: target.observedAt, deadline: context.deadline }), encoding: 'utf8', timeout: 5000, maxBuffer: 8192 })))
}

/** 每个运行至多尝试一次。再次取得完整映射后才调用原生执行器；任何拒绝/异常都不能退回仅按 PID 结束。 */
export function createProfileExecutor(context: ProfilePageContext, dependencies: {
  readonly capture: () => ProfilePageSnapshot
  readonly now: () => number
  readonly send: (target: ProfilePageTarget) => ProfileSignalReceipt
}) {
  let attempted = false
  return (target: ProfilePageTarget): { readonly snapshot: ProfilePageSnapshot, readonly receipt: ProfileSignalReceipt } => {
    if (attempted)
      throw new Error('本次运行已经尝试过页面信号')
    attempted = true
    const snapshot = dependencies.capture()
    const decision = revalidateProfilePage(target, context, snapshot, dependencies.now())
    if (decision.kind === 'refused')
      throw new Error(decision.reason)
    return { snapshot, receipt: dependencies.send(decision.target) }
  }
}
