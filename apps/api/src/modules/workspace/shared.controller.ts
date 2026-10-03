import type { SharedListQuery, SharedListResponse } from '@nerve-office/contracts'
import type { Principal } from '../auth/index.ts'
import { sharedListQuerySchema } from '@nerve-office/contracts'
import { Controller, Get, Query } from '@nestjs/common'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf } from '../documents/index.ts'
import { SharedDirectoryService } from './shared-directory.service.ts'

/**
 * "与我共享"（M2-P5 设计 §3.2、§3.4(4)，US-M2-10）：我有单独授权的全部文档，按更新时间分页。
 * 不按空间，所以挂在顶层的 /api/shared 上（与搜索相同）；规则与数据在 documents 模块。
 */
@Controller('shared')
export class SharedController {
  constructor(private readonly shared: SharedDirectoryService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: sharedListQuerySchema }) query: SharedListQuery,
  ): Promise<SharedListResponse> {
    return this.shared.list(accessActorOf(principal), query)
  }
}
