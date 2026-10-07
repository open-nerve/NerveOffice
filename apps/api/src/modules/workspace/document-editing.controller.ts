import type { AcquiredEditLease, AcquireEditLeaseRequest, DeclineEditRequest, EditRequestOutcome, EditStatus, HandedOverEditLease, HandOverEditLeaseRequest, RenewedEditLease, RenewEditLeaseRequest, RequestEditRequest } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import { acquireEditLeaseRequestSchema, declineEditRequestSchema, documentIdSchema, handOverEditLeaseRequestSchema, renewEditLeaseRequestSchema, requestEditRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common'
import { BackgroundRequest } from '../../shared/background-request.ts'
import { RequestOrigin } from '../audit/index.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { editingActorOf, EditLeaseToken } from '../documents/index.ts'
import { DocumentEditingService } from './document-editing.service.ts'

type HttpOrigin = Extract<AuditOrigin, { source: 'http' }>

/**
 * 编辑权（M3-P1 设计 §3.2）：一份文档的编辑租约。编辑状态能读就能看；申请与续租要能编辑（强制接管另要能强制接管，M3-P5 设计 §3.8）；释放能读就行。
 * 请求编辑与交出（M3-P5 设计 §3.4）：发出、续期、谢绝与交出要能编辑（谢绝与交出另带持有者的令牌），取消能读就行。
 * 令牌经请求头 x-edit-lease 传递（@EditLeaseToken()，格式不对 400，没带按没有租约处理），不进地址与日志。
 * 申请的响应带着令牌，不缓存：安全响应头已经给所有响应下发 Cache-Control: no-store（security 模块），这里不另加。
 * 挂在 workspace：响应要补持有者、请求方、留给的人的人名，documents 不依赖 users（与分享同一个做法）。
 * 编辑状态、心跳与请求方的续期是页面在后台定时发的请求（阅读页每 30 秒、编辑时每 10 秒、等待请求时每 5 秒）：@BackgroundRequest()，
 * 不顺延登录的空闲过期（M3-P2 设计 §3.2，DEF-043）；申请、释放、发出与取消请求、谢绝、交出是用户的操作，照常顺延
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
   * 申请：201；有效的租约在别人手里时 409 EDIT_LEASE_HELD；编辑权刚交给了别人、还在保留期内时 409 EDIT_LEASE_RESERVED（M3-P5）；
   * 页面过旧 409 CLIENT_OUTDATED，文档比服务端新 409 DOCUMENT_TOO_NEW。
   * 接管方式（takeover，M3-P5 设计 §3.7、§3.8）：本人接管 self 只在当前有效的租约在自己手里时起作用；强制接管 force 要能强制接管（否则 403），
   * 接管别人时写审计，来源是这个请求（请求标识与客户端地址）。续上时带的 idleSeconds（M3-P5 设计 §3.5）：新的一代的最后活动按它往前推，没带是 0；
   * 契约限它比回收阈值短（审查 A4：带到阈值的新一代一出生就按空闲失效），超出的 400
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

  /**
   * 心跳续租：200，带上待回应的请求编辑（M3-P5）；租约不再有效时 409 EDIT_LEASE_LOST，页面过旧 409 CLIENT_OUTDATED。
   * 每 10 秒一次，不顺延登录（编辑中的保存照常顺延）
   */
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

  /**
   * 交出（M3-P5 设计 §3.6）：200，编辑权留给了谁、留到何时；要交给的请求已不在时 409 EDIT_REQUEST_GONE（租约不动，持有者留在编辑），
   * 持有者的那一代已失效时 409 EDIT_LEASE_LOST（回包丢了再交出得到 handed_over）。用户的操作（含页面空闲满 2 分钟之后自动交出）
   */
  @Post('handover')
  @HttpCode(200)
  async handOver(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: handOverEditLeaseRequestSchema }) body: HandOverEditLeaseRequest,
    @EditLeaseToken() token: string | undefined,
  ): Promise<HandedOverEditLease> {
    return this.editing.handOver(editingActorOf(principal), id, body.requestId, token)
  }

  /** 发出请求编辑（M3-P5 设计 §3.6）：200，请求编辑的结果（除 gone）；页面过旧时 409 CLIENT_OUTDATED，免得编辑权交给一个之后申请不了的页面 */
  @Post('request')
  @HttpCode(200)
  async sendRequest(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: requestEditRequestSchema }) body: RequestEditRequest,
  ): Promise<EditRequestOutcome> {
    return this.editing.sendRequest(editingActorOf(principal), id, body)
  }

  /** 请求方续期：200，请求编辑的结果（没有调用者的请求时是 gone）；等待中的页面每 5 秒一次，不顺延登录 */
  @Put('request')
  @BackgroundRequest()
  async renewRequest(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
  ): Promise<EditRequestOutcome> {
    return this.editing.renewRequest(editingActorOf(principal), id)
  }

  /** 取消请求编辑：204，清掉调用者的请求与留给他的保留；都没有时同样 204（页面关闭时的 keepalive 请求不看结果） */
  @Delete('request')
  @HttpCode(204)
  async cancelRequest(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
  ): Promise<void> {
    await this.editing.cancelRequest(editingActorOf(principal), id)
  }

  /** 谢绝请求编辑（持有者选了"继续编辑"）：204；请求的标识对不上时同样 204、什么也不做；持有者的那一代已失效时 409 EDIT_LEASE_LOST */
  @Post('request/decline')
  @HttpCode(204)
  async declineRequest(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: declineEditRequestSchema }) body: DeclineEditRequest,
    @EditLeaseToken() token: string | undefined,
  ): Promise<void> {
    await this.editing.declineRequest(editingActorOf(principal), id, body.requestId, token)
  }
}
