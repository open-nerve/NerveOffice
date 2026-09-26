import type { Database, Transaction } from '../database/index.ts'
import type { SpaceSummary } from './space.ts'
import { Inject, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { spaces } from '../../db/schema/spaces/index.ts'
import { DATABASE, executorOf } from '../database/index.ts'

/** 只有它读写 spaces（规范 §1.2）。 */
@Injectable()
export class SpacesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insertPersonal(ownerUserId: string, name: string, transaction?: Transaction): Promise<SpaceSummary> {
    const [row] = await executorOf(this.db, transaction)
      .insert(spaces)
      .values({ type: 'personal', name, ownerUserId })
      .returning({ id: spaces.id, name: spaces.name })
    if (row === undefined)
      throw new Error('新建个人空间没有返回记录')
    return row
  }

  async findPersonalByOwner(ownerUserId: string): Promise<SpaceSummary | undefined> {
    const [row] = await this.db
      .select({ id: spaces.id, name: spaces.name })
      .from(spaces)
      .where(and(eq(spaces.type, 'personal'), eq(spaces.ownerUserId, ownerUserId)))
    return row
  }

  async isOwner(userId: string, spaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.ownerUserId, userId)))
    return row !== undefined
  }
}
