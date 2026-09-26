import { Module } from '@nestjs/common'
import { ApplicationState } from './application-state.ts'
import { HealthController } from './health.controller.ts'

@Module({
  controllers: [HealthController],
  providers: [ApplicationState],
  exports: [ApplicationState],
})
export class HealthModule {}
