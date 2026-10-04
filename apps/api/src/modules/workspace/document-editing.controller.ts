import type { AcquiredEditLease, AcquireEditLeaseRequest, EditStatus, RenewedEditLease, RenewEditLeaseRequest } from '@nerve-office/contracts'
import type { Principal } from '../auth/index.ts'
import { acquireEditLeaseRequestSchema, documentIdSchema, renewEditLeaseRequestSchema } from '@nerve-office/contracts'
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common'
import { BackgroundRequest } from '../../shared/background-request.ts'
import { CurrentPrincipal } from '../auth/index.ts'
import { editingActorOf, EditLeaseToken } from '../documents/index.ts'
import { DocumentEditingService } from './document-editing.service.ts'

/**
 * 编辑权（M3-P1 设计 §3.2）：一份文档的编辑租约。编辑状态能读就能看；申请与续租要能编辑；释放能读就行。
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

  /** 申请：201；有效的租约在别人手里时 409 EDIT_LEASE_HELD */
  @Post()
  async acquire(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: acquireEditLeaseRequestSchema }) body: AcquireEditLeaseRequest,
  ): Promise<AcquiredEditLease> {
    return this.editing.acquire(editingActorOf(principal), id, body.clientInstanceId)
  }

  /** 心跳续租：200；租约不再有效时 409 EDIT_LEASE_LOST。每 10 秒一次，不顺延登录（编辑中的保存照常顺延） */
  @Put()
  @BackgroundRequest()
  async renew(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: documentIdSchema }) id: string,
    @Body({ schema: renewEditLeaseRequestSchema }) body: RenewEditLeaseRequest,
    @EditLeaseToken() token: string | undefined,
  ): Promise<RenewedEditLease> {
    return this.editing.renew(editingActorOf(principal), id, body.idleSeconds, token)
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
