import { canonicalLink } from '@nerve-office/contracts'
import { SheetsHyperLinkResolverService } from '@univerjs/sheets-hyper-link-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'

function normalizeUrl(value: string): string | null {
  const result = canonicalLink(value)
  return result.ok ? result.href : null
}

/** 使用真实发布 resolver；外部导航不读取书、表、公式或消息服务。 */
function resolver(urlHandler?: { normalizeUrl?: (url: string) => string | null, navigateToOtherWebsite?: (url: string) => void }) {
  const config = { getConfig: () => urlHandler === undefined ? {} : { urlHandler } }
  return new SheetsHyperLinkResolverService({} as never, {} as never, {} as never, {} as never, {} as never, config as never)
}

afterEach(() => vi.restoreAllMocks())

describe('固定 SDK 的可配置链接导航边界', () => {
  it.each([
    ['/documents/../spaces?name=a b', '/spaces?name=a%20b'],
    ['HTTPS://EXAMPLE.INVALID', 'https://example.invalid/'],
    ['mailto:person@example.invalid?subject=a b', 'mailto:person@example.invalid?subject=a%20b'],
  ])('先经平台规范化再交给配置回调：%s', async (input, expected) => {
    const navigateToOtherWebsite = vi.fn()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await resolver({ normalizeUrl, navigateToOtherWebsite }).navigateToOtherWebsite(input)
    expect(navigateToOtherWebsite).toHaveBeenCalledExactlyOnceWith(expected)
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['https://name:secret@example.invalid/', 'https://example.invalid/\nprivate', '//example.invalid/'])('平台拒绝时不调用导航或默认打开：%s', async (input) => {
    const navigateToOtherWebsite = vi.fn()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await resolver({ normalizeUrl, navigateToOtherWebsite }).navigateToOtherWebsite(input)
    expect(navigateToOtherWebsite).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('旧配置和无配置仍受原 SDK 的默认安全协议检查', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const navigateToOtherWebsite = vi.fn()
    await resolver().navigateToOtherWebsite('javascript:void(0)')
    await resolver({ navigateToOtherWebsite }).navigateToOtherWebsite('javascript:void(0)')
    await resolver().navigateToOtherWebsite('https://example.invalid/')
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.invalid/', '_blank', 'noopener noreferrer')
    expect(navigateToOtherWebsite).not.toHaveBeenCalled()
  })

  it('只配置 normalizer 没有导航接管时，默认 window.open 仍校验安全协议', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await resolver({ normalizeUrl: () => 'javascript:void(0)' }).navigateToOtherWebsite('https://example.invalid/')
    expect(open).not.toHaveBeenCalled()
  })
})
