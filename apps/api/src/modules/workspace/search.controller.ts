import type { SearchQuery, SearchResponse } from '@nerve-office/contracts'
import type { Principal } from '../auth/index.ts'
import { searchQuerySchema } from '@nerve-office/contracts'
import { Controller, Get, Query } from '@nestjs/common'
import { CurrentPrincipal } from '../auth/index.ts'
import { accessActorOf, DocumentSearchService } from '../documents/index.ts'

/**
 * 按标题搜索我能访问的文档（M2-P4 设计 §3.2）：不按空间，一次搜遍我能看到的全部空间，
 * 所以挂在顶层的 /api/search 上，不挂在 /api/documents 下面。规则与数据在 documents 模块。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly documents: DocumentSearchService) {}

  @Get()
  async search(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: searchQuerySchema }) query: SearchQuery,
  ): Promise<SearchResponse> {
    return this.documents.search(accessActorOf(principal), query)
  }
}
