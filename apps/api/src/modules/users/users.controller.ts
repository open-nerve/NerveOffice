import type { UserDirectoryQuery, UserDirectoryResponse } from '@nerve-office/contracts'
import { userDirectoryQuerySchema } from '@nerve-office/contracts'
import { Controller, Get, Query } from '@nestjs/common'
import { UsersService } from './users.service.ts'

/** 同事目录（M2-P1 设计 §3.6）：登录的成员都能用，添加成员、分享时按名字找人。 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async directory(@Query({ schema: userDirectoryQuerySchema }) query: UserDirectoryQuery): Promise<UserDirectoryResponse> {
    const found = await this.users.directory(query)
    return { items: found.map(user => ({ id: user.id, username: user.username, displayName: user.displayName })) }
  }
}
