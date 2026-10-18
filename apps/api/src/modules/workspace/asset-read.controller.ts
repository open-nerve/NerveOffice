import type { Principal } from '../auth/index.ts'
import type { AssetReadResult } from './asset-reading.service.ts'
import { assetReadTargetSchema } from '@nerve-office/contracts'
import { Controller, Get, Param, UseInterceptors } from '@nestjs/common'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf } from '../documents/index.ts'
import { AssetReadingService } from './asset-reading.service.ts'
import { AssetResponseInterceptor } from './asset-response.interceptor.ts'

@Controller('assets')
export class AssetReadController {
  constructor(private readonly images: AssetReadingService) {}

  @Get(':assetId')
  @UseInterceptors(AssetResponseInterceptor)
  async read(@CurrentPrincipal() principal: Principal, @Param('assetId', { schema: assetReadTargetSchema }) assetId: string): Promise<AssetReadResult> {
    return this.images.read(accessActorOf(principal), assetId)
  }
}
