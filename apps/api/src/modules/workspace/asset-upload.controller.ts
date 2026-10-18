import type { AssetUploadResponse } from '@nerve-office/contracts'
import type { AssetUploadInput } from '../assets/index.ts'
import type { Principal } from '../auth/index.ts'
import { Controller, Post, UseInterceptors } from '@nestjs/common'
import { AssetUpload, AssetUploadInterceptor, AssetUploadService } from '../assets/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'

@Controller('assets')
export class AssetUploadController {
  constructor(private readonly uploads: AssetUploadService) {}

  @Post()
  @UseInterceptors(AssetUploadInterceptor)
  async upload(@CurrentPrincipal() principal: Principal, @AssetUpload() input: AssetUploadInput): Promise<AssetUploadResponse> {
    return this.uploads.upload({ userId: principal.user.id, sessionId: principal.sessionId }, input.read, input.signal)
  }
}
