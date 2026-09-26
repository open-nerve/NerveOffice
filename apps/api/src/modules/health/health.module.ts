import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/index.ts'
import { ApplicationState } from './application-state.ts'
import { HealthController } from './health.controller.ts'

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [ApplicationState],
  exports: [ApplicationState],
})
export class HealthModule {}
