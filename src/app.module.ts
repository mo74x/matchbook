import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { EventStoreService } from './event-store/event-store.service';
import { MarketRegistryService } from './engine/market-registry/market-registry.service';
import { OrdersController } from './api/orders.controller';
import { MarketGateway } from './api/market.gateway';

@Module({
  imports: [],
  controllers: [AppController, OrdersController],
  providers: [
    AppService,
    PrismaService,
    EventStoreService,
    MarketRegistryService,
    MarketGateway,
  ],
})
export class AppModule {}
