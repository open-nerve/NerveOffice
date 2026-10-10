// 页面共用的连接事实。只记浏览器信号、请求先后与时间，不记请求路径、身份或内容。
export interface ConnectionView {
  readonly browserOnline: boolean
  readonly available: boolean
  readonly problem: 'offline' | 'unresponsive' | undefined
  readonly since: number | undefined
  /** 每次中断作废在它之前开始的成功回包；恢复成功本身不另起代次。 */
  readonly generation: number
}

export interface ConnectionTicket {
  readonly generation: number
  readonly sequence: number
}

export interface ConnectionState {
  readonly view: () => ConnectionView
  readonly subscribe: (listener: () => void) => () => void
  readonly beginRequest: () => ConnectionTicket
  readonly succeeded: (ticket: ConnectionTicket) => void
  readonly failed: (ticket: ConnectionTicket) => void
  readonly setBrowserOnline: (online: boolean) => void
}

export function createConnectionState(options: { readonly online: boolean, readonly now: () => number }): ConnectionState {
  let snapshot: ConnectionView = {
    browserOnline: options.online,
    available: options.online,
    problem: options.online ? undefined : 'offline',
    since: options.online ? undefined : options.now(),
    generation: 0,
  }
  let started = 0
  let settled = 0
  const listeners = new Set<() => void>()

  function publish(next: ConnectionView): void {
    snapshot = next
    for (const listener of listeners)
      listener()
  }

  function current(ticket: ConnectionTicket): boolean {
    return snapshot.browserOnline && ticket.generation === snapshot.generation && ticket.sequence >= settled
  }

  return {
    view: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    beginRequest: () => ({ generation: snapshot.generation, sequence: ++started }),
    succeeded: (ticket) => {
      if (!current(ticket))
        return
      settled = ticket.sequence
      if (!snapshot.available)
        publish({ ...snapshot, available: true, problem: undefined, since: undefined })
    },
    failed: (ticket) => {
      if (!current(ticket))
        return
      settled = ticket.sequence
      publish({ ...snapshot, available: false, problem: 'unresponsive', since: snapshot.since ?? options.now(), generation: snapshot.generation + 1 })
    },
    setBrowserOnline: (online) => {
      if (snapshot.browserOnline === online)
        return
      publish({ browserOnline: online, available: false, problem: online ? 'unresponsive' : 'offline', since: snapshot.since ?? options.now(), generation: snapshot.generation + 1 })
    },
  }
}

export const connectionState = createConnectionState({ online: typeof navigator === 'undefined' || navigator.onLine, now: () => Date.now() })
