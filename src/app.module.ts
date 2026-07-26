import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { EventStoreService } from './event-store/event-store.service';
import { MarketRegistryService } from './engine/market-registry/market-registry.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, PrismaService, EventStoreService, MarketRegistryService],
})
export class AppModule {}
