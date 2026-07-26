import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { EventStoreService } from './event-store/event-store.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, PrismaService, EventStoreService],
})
export class AppModule {}
