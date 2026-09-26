import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/index.ts'
import { SpacesRepository } from './spaces.repository.ts'
import { SpacesService } from './spaces.service.ts'

@Module({
  imports: [DatabaseModule],
  providers: [SpacesRepository, SpacesService],
  exports: [SpacesService],
})
export class SpacesModule {}
