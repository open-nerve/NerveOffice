import type { AcquiredEditLease, AcquireEditLeaseRequest, EditStatus, RenewedEditLease, RenewEditLeaseRequest } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { acquireEditLeaseRequestSchema, documentIdSchema, renewEditLeaseRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common'
import { BackgroundRequest } from '../../shared/background-request.ts'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { editingActorOf, EditLeaseToken } from '../documents/index.ts'
import { DocumentEditingService } from './document-editing.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 编辑权（M3-P1 设计 §3.2）：一份文档的编辑租约。编辑状态能读就能看；申请与续租要能编辑（强制接管另要能强制接管，M3-P5 设计 §3.8）；释放能读就行。
 * 令牌经请求头 x-edit-lease 传递（@EditLeaseToken()，格式不对 400，没带按没有租约处理），不进地址与日志。
 * 申请的响应带着令牌，不缓存：安全响应头已经给所有响应下发 Cache-Control: no-store（security 模块），这里不另加。
 * 挂在 workspace：响应要补持有者的人名，documents 不依赖 users（与分享同一个做法）。
 * 编辑状态与心跳是页面在后台定时发的请求（阅读页每 30 秒、编辑时每 10 秒）：@BackgroundRequest()，不顺延登录的空闲过期
 * （M3-P2 设计 §3.2，DEF-043）；申请与释放是用户的操作，照常顺延
 */
@Controller('documents/:id/edit-lease')
export class DocumentEditingController {
  constructor(private readonly editing: DocumentEditingService) {}

  /** 编辑状态：200；阅读页每 30 秒一次，不顺延登录 */
  @Get()
  @BackgroundRequest()
  async status(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
  ): Promise<EditStatus> {
    return this.editing.status(editingActorOf(principal), id)
  }

  /**
   * 申请：201；有效的租约在别人手里时 409 EDIT_LEASE_HELD；页面过旧 409 CLIENT_OUTDATED，文档比服务端新 409 DOCUMENT_TOO_NEW。
   * 接管方式（takeover，M3-P5 设计 §3.7、§3.8）：本人接管 self 只在当前有效的租约在自己手里时起作用；强制接管 force 要能强制接管（否则 403），
   * 接管别人时写审计，来源是这个请求（请求标识与客户端地址）。续上时带的 idleSeconds（M3-P5 设计 §3.5）：新的一代的最后活动按它往前推，没带是 0
   */
  @Post()
  async acquire(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: acquireEditLeaseRequestSchema }) body: AcquireEditLeaseRequest,
    @RequestOrigin() origin: HttpOrigin,
  ): Promise<AcquiredEditLease> {
    const { clientInstanceId, takeover, idleSeconds, ...format } = body
    return this.editing.acquire(editingActorOf(principal), id, { clientInstanceId, takeover, idleSeconds: idleSeconds ?? 0, format }, origin)
  }

  /** 心跳续租：200；租约不再有效时 409 EDIT_LEASE_LOST，页面过旧 409 CLIENT_OUTDATED。每 10 秒一次，不顺延登录（编辑中的保存照常顺延） */
  @Put()
  @BackgroundRequest()
  async renew(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: renewEditLeaseRequestSchema }) body: RenewEditLeaseRequest,
    @EditLeaseToken() token: string | undefined,
  ): Promise<RenewedEditLease> {
    const { idleSeconds, ...format } = body
    return this.editing.renew(editingActorOf(principal), id, { idleSeconds, format }, token)
  }

  /** 释放：204，没有响应体；令牌不是当前的、已经结束时同样 204（页面关闭时的 keepalive 请求不看结果） */
  @Delete()
  @HttpCode(204)
  async release(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @EditLeaseToken() token: string | undefined,
  ): Promise<void> {
    await this.editing.release(editingActorOf(principal), id, token)
  }
}
