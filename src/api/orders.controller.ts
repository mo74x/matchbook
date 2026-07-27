import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { MarketRegistryService } from '../engine/market-registry/market-registry.service';
import { EventStoreService } from '../event-store/event-store.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { randomUUID } from 'crypto';
import { Order } from '../domain/types/order.types';
import {
  OptionalJwtAuthGuard,
  JwtAuthGuard,
} from '../auth/guards/jwt-auth.guard';
import * as currentUserDecorator from '../auth/decorators/current-user.decorator';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  constructor(
    private readonly registry: MarketRegistryService,
    private readonly eventStore: EventStoreService,
  ) {}

  @Post()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a new order to the matching engine' })
  @ApiResponse({
    status: 201,
    description: 'Order submitted and matched successfully.',
  })
  @ApiResponse({ status: 400, description: 'Invalid order parameters.' })
  async placeOrder(
    @Body() dto: CreateOrderDto,
    @currentUserDecorator.CurrentUser() user?: currentUserDecorator.UserPayload,
  ) {
    try {
      const order: Order = {
        id: randomUUID(),
        instrument: dto.instrument,
        side: dto.side,
        type: dto.type || 'LIMIT',
        price: dto.price,
        initialQuantity: dto.quantity,
        remainingQuantity: dto.quantity,
        timestamp: Date.now(),
        userId: user?.userId,
      };

      const start = Date.now();
      const result = await this.registry.submitOrder(order);
      const latencyMs = Date.now() - start;

      this.logger.log({
        event: 'ORDER_SUBMITTED',
        orderId: order.id,
        instrument: order.instrument,
        type: order.type,
        side: order.side,
        price: order.price,
        quantity: order.initialQuantity,
        latencyMs,
      });

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
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
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
    @currentUserDecorator.CurrentUser() user?: currentUserDecorator.UserPayload,
  ) {
    try {
      const result = await this.registry.cancelOrder(
        instrument,
        orderId,
        user?.userId,
      );
      if (!result.success) {
        if (result.message?.includes('Unauthorized')) {
          throw new UnauthorizedException(result.message);
        }
        throw new NotFoundException(
          result.message || 'Order not found resting in order book',
        );
      }
      return result;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof UnauthorizedException
      )
        throw error;
      throw new BadRequestException((error as Error).message);
    }
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get orders belonging to the authenticated user' })
  @ApiResponse({
    status: 200,
    description: 'User orders retrieved successfully.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  async getMyOrders(
    @currentUserDecorator.CurrentUser() user: currentUserDecorator.UserPayload,
  ) {
    const orders = await this.eventStore.getUserOrders(user.userId);
    return {
      orders,
      count: orders.length,
    };
  }

  @Get('mine/trades')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get trades executed by the authenticated user' })
  @ApiResponse({
    status: 200,
    description: 'User trades retrieved successfully.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  async getMyTrades(
    @currentUserDecorator.CurrentUser() user: currentUserDecorator.UserPayload,
  ) {
    const trades = await this.eventStore.getUserTrades(user.userId);
    return {
      trades,
      count: trades.length,
    };
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
