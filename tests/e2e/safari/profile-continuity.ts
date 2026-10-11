// 本机维护的已知测试页面清单，不接受 HTTP 页面自证。归属矛盾永久锁存，不能等页面回来之后重新认领。
import type { SafariProfileProof } from './profile-process.ts'
import { z } from 'zod'

const ownedUrl = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return url.href === value && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && Number(url.port) >= 1024 && url.pathname !== '/' && url.username === '' && url.password === '' && url.hash === ''
  }
  catch {
    return false
  }
})
const schema = z.object({ windowId: z.number().int().positive().safe(), axWindowUuid: z.uuid(), valid: z.boolean(), urls: z.array(ownedUrl).min(1) }).strict()
export type OwnedPages = z.infer<typeof schema>

export function parseOwnedPages(value: unknown): OwnedPages {
  return schema.parse(value)
}

export function createProfileContinuity(profile: Pick<SafariProfileProof, 'windowId' | 'axWindowUuid'>, ledger: OwnedPages) {
  if (!ledger.valid || ledger.windowId !== profile.windowId || ledger.axWindowUuid !== profile.axWindowUuid)
    throw new Error('专用场景历史证明已失效或与创建时绑定不符')
  let valid = true
  return {
    accept(windows: readonly { readonly windowId: number, readonly profileMatches: boolean, readonly tabs: readonly { readonly index: number, readonly knownUrlMatches?: boolean }[] }[]): boolean {
      const matching = windows.filter(window => window.profileMatches)
      const window = matching[0]
      valid &&= matching.length === 1 && window?.windowId === profile.windowId && window.tabs.length === 1 && window.tabs[0]?.index === 1 && window.tabs[0].knownUrlMatches === true
        && new Set(windows.map(window => window.windowId)).size === windows.length
      return valid
    },
    valid: () => valid,
  }
}
