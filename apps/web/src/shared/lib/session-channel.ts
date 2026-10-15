/**
 * 同一个浏览器里，本站各个标签页之间传"会话变了"（登录、退出）的消息（审查 B6）。
 * 会话 Cookie 是各标签页共用的：一个标签页换了人，别的标签页还显示着上一个人的页面，拿着上一个会话的 CSRF 令牌。
 * 消息不带任何内容，收到的一方自己向服务端确认现在是谁。同一 Document 共用一个原生通道：原生 API 只排除发送实例，
 * 如果本页每个调用者各建一个实例，它们会收到本页的通知、重复确认会话。
 */
export interface SessionChannel {
  /** 告诉其他标签页：会话变了 */
  announce: () => void
  /** 其他标签页的会话变了时调用 listener；返回取消订阅的函数 */
  subscribe: (listener: () => void) => () => void
  close: () => void
}

const CHANNEL_NAME = 'nerve-office:session'
const SESSION_CHANGED = 'session-changed'

const NO_CHANNEL: SessionChannel = {
  announce: () => {},
  subscribe: () => () => {},
  close: () => {},
}

let shared: { readonly channel: BroadcastChannel, users: number } | undefined

export function openSessionChannel(): SessionChannel {
  // 目标浏览器都支持；没有时退化为不通知，别的标签页在下一次状态变更请求时由 CSRF 校验发现（app/runtime.ts）
  if (typeof BroadcastChannel === 'undefined')
    return NO_CHANNEL
  const owner = shared ??= { channel: new BroadcastChannel(CHANNEL_NAME), users: 0 }
  const { channel } = owner
  owner.users += 1
  let closed = false
  const subscriptions = new Set<() => void>()
  return {
    announce: () => {
      if (!closed)
        channel.postMessage(SESSION_CHANGED)
    },
    subscribe: (listener) => {
      if (closed)
        return () => {}
      const onMessage = (event: MessageEvent<unknown>): void => {
        if (event.data === SESSION_CHANGED)
          listener()
      }
      channel.addEventListener('message', onMessage)
      const unsubscribe = () => {
        channel.removeEventListener('message', onMessage)
        subscriptions.delete(unsubscribe)
      }
      subscriptions.add(unsubscribe)
      return unsubscribe
    },
    close: () => {
      if (closed)
        return
      closed = true
      for (const unsubscribe of subscriptions)
        unsubscribe()
      owner.users -= 1
      if (owner.users === 0) {
        channel.close()
        if (shared === owner)
          shared = undefined
      }
    },
  }
}
