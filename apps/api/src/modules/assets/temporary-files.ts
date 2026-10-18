import { Injectable } from '@nestjs/common'
import { ExclusiveRunner } from '../database/index.ts'

/** 与文件系统无关的占用接口；成功取得占用的整个回调结束前不得释放。 */
export interface TemporaryFileLeases {
  tryRun: <T>(id: string, work: () => Promise<T>) => Promise<{ readonly ran: true, readonly result: T } | { readonly ran: false }>
}

/** 不开事务、不取配额行锁；进程/连接消失时 PostgreSQL 自动释放该任务占用。 */
@Injectable()
export class AssetTemporaryFiles implements TemporaryFileLeases {
  constructor(private readonly exclusive: ExclusiveRunner) {}

  async tryRun<T>(id: string, work: () => Promise<T>): Promise<{ readonly ran: true, readonly result: T } | { readonly ran: false }> {
    return this.exclusive.run(`nerve-office:asset-staging:${id}`, work)
  }
}
