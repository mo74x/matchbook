/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderBook } from '../domain/OrderBook';
import { Order } from '../domain/types/order.types';
import {
  EventToPersist,
  OrderPlacedPayload,
  OrderMatchedPayload,
  OrderPartiallyFilledPayload,
} from '../domain/types/event.types';
import { EventType } from '../../generated/prisma/enums';

export interface StoredOrderEvent {
  sequenceId: bigint;
  instrument: string;
  eventType: EventType;
  orderId: string;
  payload: any;
  createdAt: Date;
}

@Injectable()
export class EventStoreService {
  private readonly logger = new Logger(EventStoreService.name);

  constructor(private readonly prisma: PrismaService) {}
  /**
   * Appends a list of domain events to the persistence layer.
   * This is the "write-side" operation for the Event Sourcing pattern.
   * It uses Prisma's `createMany` for efficient batch insertion.
   */
  async appendEvents(events: EventToPersist[]): Promise<void> {
    if (events.length === 0) return;

    await this.prisma.orderEvent.createMany({
      data: events.map((e) => ({
        instrument: e.instrument,
        eventType: e.eventType,
        orderId: e.orderId,
        payload: e.payload as any,
      })),
    });
  }

  /**
   * Fetches all events for an instrument and reconstructs the in-memory state.
   */
  async recoverOrderBook(instrument: string): Promise<OrderBook> {
    this.logger.log(`Starting crash recovery for ${instrument}...`);
    const startTime = Date.now();

    const book = new OrderBook(instrument);

    // Fetch all events strictly ordered by their database sequence ID
    const events = await this.prisma.orderEvent.findMany({
      where: { instrument },
      orderBy: { sequenceId: 'asc' },
    });

    for (const event of events) {
      this.applyEventToBook(book, event);
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Recovered ${events.length} events for ${instrument} in ${duration}ms.`,
    );

    return book;
  }

  /**
   * Projects a single event onto the OrderBook state.
   */
  private applyEventToBook(book: OrderBook, event: StoredOrderEvent): void {
    const payload = event.payload;

    switch (event.eventType) {
      case EventType.ORDER_PLACED: {
        const p = payload as OrderPlacedPayload;
        // Hydrate the resting order
        const order: Order = {
          id: event.orderId,
          instrument: event.instrument,
          side: p.side,
          price: p.price,
          initialQuantity: p.quantity,
          remainingQuantity: p.quantity,
          timestamp: event.createdAt.getTime(),
        };
        book.add(order);
        break;
      }

      case EventType.ORDER_PARTIALLY_FILLED: {
        const p = payload as OrderPartiallyFilledPayload;
        const restingOrder = book.getOrder(event.orderId);
        if (restingOrder) {
          restingOrder.remainingQuantity = p.remainingQuantity;
        }
        break;
      }

      case EventType.ORDER_MATCHED: {
        const p = payload as OrderMatchedPayload;
        // ORDER_MATCHED contains the counterpartyOrderId (the resting order)
        const restingOrder = book.getOrder(p.counterpartyOrderId);
        if (restingOrder) {
          restingOrder.remainingQuantity -= p.matchedQuantity;
          // If the resting order is fully consumed, remove it
          if (restingOrder.remainingQuantity <= 0) {
            book.removeOrder(restingOrder.id);
          }
        }
        break;
      }

      case EventType.ORDER_CANCELLED: {
        book.removeOrder(event.orderId);
        break;
      }
    }
  }
}
