/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { MarketRegistryService } from '../engine/market-registry/market-registry.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { randomUUID } from 'crypto';
import { Order } from '../domain/types/order.types';

@Controller('orders')
export class OrdersController {
  constructor(private readonly registry: MarketRegistryService) {}

  @Post()
  async placeOrder(@Body() dto: CreateOrderDto) {
    try {
      // Map the incoming HTTP request to our internal Domain Order object
      const order: Order = {
        id: randomUUID(),
        instrument: dto.instrument,
        side: dto.side,
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
      throw new BadRequestException(error.message);
    }
  }

  @Get('book/:instrument')
  getOrderBook(@Param('instrument') instrument: string) {
    try {
      const book = this.registry.getOrderBook(instrument);

      // We don't want to send the entire massive internal Maps over HTTP.
      // We just send the best bid and best ask for simple rendering.
      return {
        instrument,
        bestBid: book.getBestBid()?.price || null,
        bestAsk: book.getBestAsk()?.price || null,
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }
}
