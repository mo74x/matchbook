import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Body,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { MarketRegistryService } from '../engine/market-registry/market-registry.service';
import { EventStoreService } from '../event-store/event-store.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { randomUUID } from 'crypto';
import { Order } from '../domain/types/order.types';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly registry: MarketRegistryService,
    private readonly eventStore: EventStoreService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Submit a new order to the matching engine' })
  @ApiResponse({
    status: 201,
    description: 'Order submitted and matched successfully.',
  })
  @ApiResponse({ status: 400, description: 'Invalid order parameters.' })
  async placeOrder(@Body() dto: CreateOrderDto) {
    try {
      // Map the incoming HTTP request to our internal Domain Order object
      const order: Order = {
        id: randomUUID(),
        instrument: dto.instrument,
        side: dto.side,
        type: dto.type || 'LIMIT',
        price: dto.price,
        initialQuantity: dto.quantity,
        remainingQuantity: dto.quantity,
        timestamp: Date.now(),
      };

      // Send it to the engine
      const result = await this.registry.submitOrder(order);

      return {
        message: 'Order processed successfully',
        orderId: order.id,
        trades: result.trades,
      };
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Delete(':instrument/:orderId')
  @ApiOperation({ summary: 'Cancel a resting order' })
  @ApiParam({ name: 'instrument', example: 'BTC-USD' })
  @ApiParam({
    name: 'orderId',
    example: 'd3b07384-d113-40a4-a719-8134707297e2',
  })
  @ApiResponse({ status: 200, description: 'Order cancelled successfully.' })
  @ApiResponse({ status: 404, description: 'Order not found in resting book.' })
  async cancelOrder(
    @Param('instrument') instrument: string,
    @Param('orderId') orderId: string,
  ) {
    try {
      const result = await this.registry.cancelOrder(instrument, orderId);
      if (!result.success) {
        throw new NotFoundException(
          result.message || 'Order not found resting in order book',
        );
      }
      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException((error as Error).message);
    }
  }

  @Get('book/:instrument')
  @ApiOperation({ summary: 'Get best bid and best ask for an instrument' })
  @ApiParam({ name: 'instrument', example: 'BTC-USD' })
  getOrderBook(@Param('instrument') instrument: string) {
    try {
      const book = this.registry.getOrderBook(instrument);

      return {
        instrument,
        bestBid: book.getBestBid()?.price || null,
        bestAsk: book.getBestAsk()?.price || null,
      };
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Get('book/:instrument/depth')
  @ApiOperation({ summary: 'Get aggregated L2 order book depth' })
  @ApiParam({ name: 'instrument', example: 'BTC-USD' })
  @ApiQuery({ name: 'depth', required: false, example: '20' })
  getBookDepth(
    @Param('instrument') instrument: string,
    @Query('depth') depth?: string,
  ) {
    try {
      const parsedDepth = depth ? parseInt(depth, 10) : 20;
      const book = this.registry.getOrderBook(instrument);
      const depthData = book.getDepth(isNaN(parsedDepth) ? 20 : parsedDepth);

      return {
        instrument,
        ...depthData,
      };
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Get order status and complete event trail' })
  @ApiParam({
    name: 'orderId',
    example: 'd3b07384-d113-40a4-a719-8134707297e2',
  })
  @ApiResponse({
    status: 200,
    description: 'Order status retrieved successfully.',
  })
  @ApiResponse({ status: 404, description: 'Order not found.' })
  async getOrderStatus(@Param('orderId') orderId: string) {
    try {
      const status = await this.eventStore.getOrderStatus(orderId);
      if (!status) {
        throw new NotFoundException(`Order ${orderId} not found`);
      }
      return status;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException((error as Error).message);
    }
  }
}
