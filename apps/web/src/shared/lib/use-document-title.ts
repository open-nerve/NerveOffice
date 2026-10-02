import { useEffect } from 'react'
import { messages } from '../i18n/index.ts'

/**
 * 浏览器标签页上的标题（WCAG 2.4.2，M2-P6 复核 S4）："页面的名称 - NerveOffice"。每个页面在显示自己的内容时调用一次；
 * title 为 undefined 时不设置（例如外层的空间页在内容区显示出来之后，由内容区按当前的文件夹设置）。
 * 卸载或换了标题时先回到产品名：下一个页面的 effect 随即设置自己的（React 先执行全部的清理、再执行新的 effect）。
 */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (title === undefined)
      return undefined
    document.title = messages.app.pageTitle(title)
    return () => {
      document.title = messages.app.name
    }
  }, [title])
}
