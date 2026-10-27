import type { Transaction } from '../database/index.ts'
import { Injectable } from '@nestjs/common'
import { AssetGcRepository } from './asset-gc.repository.ts'

export abstract class AssetGcClock {
  abstract now(transaction: Transaction): Promise<Date>
}

@Injectable()
export class DatabaseAssetGcClock extends AssetGcClock {
  constructor(private readonly repository: AssetGcRepository) {
    super()
  }

  override async now(transaction: Transaction): Promise<Date> {
    return this.repository.now(transaction)
  }
}
