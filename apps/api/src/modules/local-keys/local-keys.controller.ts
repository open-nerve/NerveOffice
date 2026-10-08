import type { LocalKey } from '@nerve-office/contracts'
import type { Principal } from '../auth/index.ts'
import { Controller, HttpCode, Post } from '@nestjs/common'
import { CurrentPrincipal } from '../auth/index.ts'
import { LocalKeyService } from './local-key.service.ts'

/**
 * 本人的本机密钥（M3-P6 设计 §3.5）：登录之后的页面按需取当前的那一把（M4 起：打开文档、进入编辑之前，吊销之后再取一次）。
 * 用 POST 不用 GET：第一次取时生成第 1 版、要写库，而登录之后的 GET 一律在只读快照里（ADR-017）；CSRF 与 Origin 检查随之生效。
 * 不是后台请求（ADR-007：用户操作的结果，次数有限，照常顺延登录）；不单独限流（DEF-054）。
 * 响应带着原始密钥：所有响应都带 Cache-Control: no-store（security 模块），请求日志不记响应体
 */
@Controller('local-key')
export class LocalKeysController {
  constructor(private readonly keys: LocalKeyService) {}

  /** 200：版本与 32 字节的标准 base64；登录在事务里核对时已经失效 401 SESSION_EXPIRED；解不开时 500 */
  @Post()
  @HttpCode(200)
  async fetch(@CurrentPrincipal() principal: Principal): Promise<LocalKey> {
    return this.keys.fetch(principal)
  }
}
