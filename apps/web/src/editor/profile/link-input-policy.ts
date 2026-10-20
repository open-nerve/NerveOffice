import type { IDisposable } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import { canonicalLink } from '@nerve-office/contracts'
import { LINK_INPUT_COMMANDS } from '../internal-api/ui.ts'
import { LINK_INPUT_INVALID_MESSAGE } from './locale.ts'

/** 明确输入不猜协议；与保存检查、自动链接清洗共用同一地址规则。 */
export function normalizeLinkInput(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const result = canonicalLink(value)
  return result.ok ? result.href : null
}

/** 配置本身无 I/O；SDK 只在明确点击时调用导航，内部锚点由其原 resolver 处理。 */
export const linkUiConfig = {
  urlHandler: {
    normalizeUrl: normalizeLinkInput,
    navigateToOtherWebsite: (url: string): void => {
      const href = normalizeLinkInput(url)
      if (href !== null && !href.startsWith('#'))
        window.open(href, '_blank', 'noopener,noreferrer')
    },
  },
}

const ADDRESS_FIELDS = new Map([
  [LINK_INPUT_COMMANDS.add, 'link'],
  [LINK_INPUT_COMMANDS.addRich, 'link'],
  [LINK_INPUT_COMMANDS.update, 'payload'],
  [LINK_INPUT_COMMANDS.updateRich, 'payload'],
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeCommand(params: unknown, field: string): boolean {
  if (!record(params) || !record(params[field]))
    return false
  const link = params[field]
  const href = normalizeLinkInput(link.payload)
  if (href === null)
    return false
  if (link.payload !== href)
    link.payload = href
  return link.payload === href
}

/** 在 SDK 改显示内容、写入模型或生成撤销记录之前检查，不能靠最后清洗掩盖明确输入失败。 */
export function installLinkInputPolicy(univerAPI: FUniver): IDisposable {
  return univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
    if (event.cancel)
      return
    const field = ADDRESS_FIELDS.get(event.id)
    if (field === undefined)
      return
    let accepted = false
    try {
      accepted = normalizeCommand(event.params, field)
    }
    catch {
      // 不可写或无法可靠读取的命令参数，同样在 SDK 执行前取消。
    }
    if (!accepted) {
      event.cancel = true
      univerAPI.showMessage({ content: LINK_INPUT_INVALID_MESSAGE })
    }
  })
}
