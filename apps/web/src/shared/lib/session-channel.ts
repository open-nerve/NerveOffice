/**
 * 同一个浏览器里，本站各个标签页之间传"会话变了"（登录、退出）的消息（审查 B6）。
 * 会话 Cookie 是各标签页共用的：一个标签页换了人，别的标签页还显示着上一个人的页面，拿着上一个会话的 CSRF 令牌。
 * 消息不带任何内容，收到的一方自己向服务端确认现在是谁；发出的一方自己收不到自己的消息（BroadcastChannel 的约定）。
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

export function openSessionChannel(): SessionChannel {
  // 目标浏览器都支持；没有时退化为不通知，别的标签页在下一次状态变更请求时由 CSRF 校验发现（app/runtime.ts）
  if (typeof BroadcastChannel === 'undefined')
    return NO_CHANNEL
  const channel = new BroadcastChannel(CHANNEL_NAME)
  return {
    announce: () => channel.postMessage(SESSION_CHANGED),
    subscribe: (listener) => {
      const onMessage = (event: MessageEvent<unknown>): void => {
        if (event.data === SESSION_CHANGED)
          listener()
      }
      channel.addEventListener('message', onMessage)
      return () => channel.removeEventListener('message', onMessage)
    },
    close: () => channel.close(),
  }
}
