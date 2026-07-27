import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { EventStoreService } from '../event-store/event-store.service';

@ApiTags('trades')
@Controller('trades')
export class TradesController {
  constructor(private readonly eventStore: EventStoreService) {}

  @Get()
  @ApiOperation({ summary: 'Get recent trade execution history' })
  @ApiQuery({ name: 'instrument', required: false, example: 'BTC-USD' })
  @ApiQuery({ name: 'limit', required: false, example: '50' })
  @ApiResponse({
    status: 200,
    description: 'Trade history retrieved successfully.',
  })
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
