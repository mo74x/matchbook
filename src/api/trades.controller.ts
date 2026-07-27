import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { EventStoreService } from '../event-store/event-store.service';

@Controller('trades')
export class TradesController {
  constructor(private readonly eventStore: EventStoreService) {}

  @Get()
  async getTrades(
    @Query('instrument') instrument?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const parsedLimit = limit ? parseInt(limit, 10) : 50;
      const trades = await this.eventStore.getTrades(
        instrument,
        isNaN(parsedLimit) ? 50 : parsedLimit,
      );
      return {
        trades,
        count: trades.length,
      };
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
}
