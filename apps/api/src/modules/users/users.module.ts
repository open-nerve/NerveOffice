import type { AppConfig } from '../config/index.ts'
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/index.ts'
import { APP_CONFIG } from '../config/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { SpacesModule } from '../spaces/index.ts'
import { AdminInitializationService } from './admin-initialization.service.ts'
import { Argon2PasswordHasher, PasswordHasher } from './password-hasher.ts'
import { UsersRepository } from './users.repository.ts'
import { UsersService } from './users.service.ts'

@Module({
  imports: [DatabaseModule, SpacesModule, AuditModule],
  providers: [
    UsersRepository,
    UsersService,
    AdminInitializationService,
    {
      provide: PasswordHasher,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new Argon2PasswordHasher(config.password.argon2, config.password.hashConcurrency),
    },
  ],
  exports: [UsersService, AdminInitializationService],
})
export class UsersModule {}
