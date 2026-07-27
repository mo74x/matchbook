/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
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
   * Persists a snapshot of the current OrderBook state for fast crash recovery.
   */
  async createSnapshot(
    instrument: string,
    book: OrderBook,
    lastSequence: bigint,
  ): Promise<void> {
    const depth = book.getDepth(1000);
    await this.prisma.orderBookSnapshot.create({
      data: {
        instrument,
        lastSequence,
        snapshotData: depth as any,
      },
    });
    this.logger.log(
      `Created OrderBook snapshot for ${instrument} at sequence ${lastSequence}`,
    );
  }

  /**
   * Reconstructs in-memory OrderBook state using latest snapshot + replaying subsequent events.
   */
  async recoverOrderBook(instrument: string): Promise<OrderBook> {
    this.logger.log(`Starting crash recovery for ${instrument}...`);
    const startTime = Date.now();

    const book = new OrderBook(instrument);

    // Look for latest snapshot
    const latestSnapshot = await this.prisma.orderBookSnapshot.findFirst({
      where: { instrument },
      orderBy: { lastSequence: 'desc' },
    });

    let startSequence = 0n;

    if (latestSnapshot) {
      startSequence = latestSnapshot.lastSequence;
      const snapshot = latestSnapshot.snapshotData as any;
      if (snapshot && snapshot.bids && snapshot.asks) {
        for (const b of snapshot.bids) {
          book.add({
            id: `snap-bid-${b.price}`,
            instrument,
            side: 'BID',
            price: b.price,
            initialQuantity: b.quantity,
            remainingQuantity: b.quantity,
            timestamp: Date.now(),
          });
        }
        for (const a of snapshot.asks) {
          book.add({
            id: `snap-ask-${a.price}`,
            instrument,
            side: 'ASK',
            price: a.price,
            initialQuantity: a.quantity,
            remainingQuantity: a.quantity,
            timestamp: Date.now(),
          });
        }
      }
    }

    // Replay subsequent events after the snapshot
    const events = await this.prisma.orderEvent.findMany({
      where: {
        instrument,
        sequenceId: { gt: startSequence },
      },
      orderBy: { sequenceId: 'asc' },
    });

    for (const event of events) {
      this.applyEventToBook(book, event);
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Recovered ${instrument} (Snapshot: ${latestSnapshot ? 'YES' : 'NO'}, Replayed Events: ${events.length}) in ${duration}ms.`,
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

  /**
   * Fetches recent trades (ORDER_MATCHED events) from the database.
   */
  async getTrades(instrument?: string, limit: number = 50) {
    const events = await this.prisma.orderEvent.findMany({
      where: {
        eventType: EventType.ORDER_MATCHED,
        ...(instrument ? { instrument } : {}),
      },
      orderBy: { sequenceId: 'desc' },
      take: limit,
    });

    return events.map((e) => {
      const payload = e.payload as unknown as OrderMatchedPayload;
      return {
        tradeId: payload.tradeId,
        instrument: e.instrument,
        takerOrderId: e.orderId,
        makerOrderId: payload.counterpartyOrderId,
        price: payload.matchedPrice ?? payload.price,
        quantity: payload.matchedQuantity,
        executedAt: e.createdAt,
      };
    });
  }

  /**
   * Fetches the complete event history and current status for a given order ID.
   */
  async getOrderStatus(orderId: string) {
    const events = await this.prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { sequenceId: 'asc' },
    });

    if (events.length === 0) {
      return null;
    }

    const placedEvent = events.find(
      (e) => e.eventType === EventType.ORDER_PLACED,
    );
    const cancelEvent = events.find(
      (e) => e.eventType === EventType.ORDER_CANCELLED,
    );

    let status = 'OPEN';
    let remainingQuantity = 0;
    let initialQuantity = 0;
    let side = '';
    let price = 0;
    let instrument = '';

    if (placedEvent) {
      const p = placedEvent.payload as unknown as OrderPlacedPayload;
      initialQuantity = p.quantity;
      remainingQuantity = p.quantity;
      side = p.side;
      price = p.price;
      instrument = placedEvent.instrument;
    }

    let totalFilled = 0;
    for (const e of events) {
      if (e.eventType === EventType.ORDER_MATCHED) {
        const p = e.payload as unknown as OrderMatchedPayload;
        totalFilled += p.matchedQuantity;
      } else if (e.eventType === EventType.ORDER_PARTIALLY_FILLED) {
        const p = e.payload as unknown as OrderPartiallyFilledPayload;
        remainingQuantity = p.remainingQuantity;
      }
    }

    if (initialQuantity > 0) {
      remainingQuantity = Math.max(0, initialQuantity - totalFilled);
    }

    if (cancelEvent) {
      status = 'CANCELLED';
    } else if (remainingQuantity === 0 && initialQuantity > 0) {
      status = 'FILLED';
    } else if (totalFilled > 0 && remainingQuantity > 0) {
      status = 'PARTIALLY_FILLED';
    }

    return {
      orderId,
      instrument,
      side,
      price,
      initialQuantity,
      remainingQuantity,
      status,
      events: events.map((e) => ({
        sequenceId: e.sequenceId.toString(),
        eventType: e.eventType,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
    };
  }
}
