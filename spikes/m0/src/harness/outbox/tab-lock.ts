// 标签页协调（P6，00 号计划书 §7.5）：处于编辑状态的标签页用 Web Locks 持有这份文档的排他锁；
// 页面关闭或崩溃后锁自动释放。拿不到锁的标签页不写发件箱、不上传，恢复流程只在拿到锁之后启动。
export type TabLockState = 'held' | 'busy' | 'lost' | 'released';

export interface TabLock {
    readonly name: string;
    state(): TabLockState;
    /** 锁被其他标签页抢走（steal）时的回调。 */
    onLost(listener: () => void): void;
    release(): void;
}

export const lockName = (docId: string) => `nerve-doc:${docId}`;

/**
 * 申请文档的排他锁：
 * - 默认 ifAvailable：被占用时立即返回 busy；
 * - wait：排队等到拿到为止；
 * - steal：抢走别人的锁（对方收到 lost）。
 */
export function acquireDocLock(docId: string, mode: 'ifAvailable' | 'wait' | 'steal' = 'ifAvailable'): Promise<TabLock> {
    const name = lockName(docId);
    let state: TabLockState = 'busy';
    const lostListeners: (() => void)[] = [];
    let release: () => void = () => undefined;
    return new Promise((resolve, reject) => {
        const handle: TabLock = {
            name,
            state: () => state,
            onLost: (l) => lostListeners.push(l),
            release: () => {
                if (state === 'held') state = 'released';
                release();
            },
        };
        const options: LockOptions = mode === 'ifAvailable' ? { mode: 'exclusive', ifAvailable: true } : mode === 'steal' ? { mode: 'exclusive', steal: true } : { mode: 'exclusive' };
        navigator.locks.request(name, options, (lock) => {
            if (lock == null) {
                resolve(handle);
                return undefined;
            }
            state = 'held';
            resolve(handle);
            // 持有到 release() 为止
            return new Promise<void>((r) => {
                release = r;
            });
        }).catch((e: unknown) => {
            // 被 steal 时，原持有者的 request() 以 AbortError 拒绝
            if (state === 'held') {
                state = 'lost';
                lostListeners.forEach((l) => l());
            } else reject(e);
        });
    });
}
