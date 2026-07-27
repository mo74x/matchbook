import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { EventStoreService } from './event-store/event-store.service';
import { MarketRegistryService } from './engine/market-registry/market-registry.service';
import { OrdersController } from './api/orders.controller';
import { TradesController } from './api/trades.controller';
import { HealthController } from './api/health.controller';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';
import { MarketGateway } from './api/market.gateway';
import { ApiKeyGuard } from './api/guards/api-key.guard';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
  ],
  controllers: [
    AppController,
    OrdersController,
    TradesController,
    HealthController,
    MetricsController,
  ],
  providers: [
    AppService,
    PrismaService,
    EventStoreService,
    MarketRegistryService,
    MarketGateway,
    MetricsService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
})
export class AppModule {}
