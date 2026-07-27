import { Order, Trade } from './types/order.types';
import { PendingDomainEvent } from './types/event.types';
import { EventType } from '../../generated/prisma/enums';
import { OrderBook } from './OrderBook';
import { randomUUID } from 'crypto';

export interface MatchingResult {
  trades: Trade[];
  events: PendingDomainEvent[];
}

export class MatchingEngine {
  /**
   * Processes a new incoming order against the resting order book.
   */
  public static processOrder(
    incomingOrder: Order,
    book: OrderBook,
  ): MatchingResult {
    const result: MatchingResult = {
      trades: [],
      events: [],
    };

    const orderType = incomingOrder.type || 'LIMIT';
    let remainingQty = incomingOrder.initialQuantity;

    // FOK (Fill or Kill) Pre-check: Must fill 100% or cancel immediately without execution
    if (orderType === 'FOK') {
      const fillable = this.calculateFillableQuantity(incomingOrder, book);
      if (fillable < incomingOrder.initialQuantity) {
        result.events.push({
          eventType: EventType.ORDER_CANCELLED,
          orderId: incomingOrder.id,
          payload: {
            side: incomingOrder.side,
            price: incomingOrder.price,
            remainingQuantity: incomingOrder.initialQuantity,
          },
        });
        return result;
      }
    }

    // Attempt to match aggressively against resting orders
    while (remainingQty > 0) {
      // Find the best counterparty price
      const bestLevel =
        incomingOrder.side === 'BID' ? book.getBestAsk() : book.getBestBid();

      // If there's no counterparty, stop matching
      if (!bestLevel) break;

      // Price limit check for non-market orders
      if (orderType !== 'MARKET') {
        if (
          incomingOrder.side === 'BID' &&
          incomingOrder.price < bestLevel.price
        )
          break;
        if (
          incomingOrder.side === 'ASK' &&
          incomingOrder.price > bestLevel.price
        )
          break;
      }

      // We have a price match! Iterate through the FIFO queue at this price level
      while (remainingQty > 0 && bestLevel.orders.length > 0) {
        const restingOrder = bestLevel.peek()!;

        // Calculate the trade quantity
        const tradedQty = Math.min(
          remainingQty,
          restingOrder.remainingQuantity,
        );
        const executePrice = restingOrder.price; // Trade always happens at the Maker's price

        // Create the Trade record
        const tradeId = randomUUID();
        const trade: Trade = {
          id: tradeId,
          instrument: incomingOrder.instrument,
          makerOrderId: restingOrder.id,
          takerOrderId: incomingOrder.id,
          price: executePrice,
          quantity: tradedQty,
          executedAt: Date.now(),
        };
        result.trades.push(trade);

        // Update quantities
        remainingQty -= tradedQty;
        restingOrder.remainingQuantity -= tradedQty;

        // Generate Match Events for the Event Log
        result.events.push({
          eventType: EventType.ORDER_MATCHED,
          orderId: incomingOrder.id,
          payload: {
            side: incomingOrder.side,
            price: incomingOrder.price,
            counterpartyOrderId: restingOrder.id,
            matchedQuantity: tradedQty,
            matchedPrice: executePrice,
            tradeId: trade.id,
          },
        });

        // If the resting order is fully filled, remove it from the book
        if (restingOrder.remainingQuantity === 0) {
          bestLevel.removeOrder(restingOrder.id);
        } else {
          // Resting order partially filled
          result.events.push({
            eventType: EventType.ORDER_PARTIALLY_FILLED,
            orderId: restingOrder.id,
            payload: {
              side: restingOrder.side,
              price: restingOrder.price,
              filledQuantity: tradedQty,
              remainingQuantity: restingOrder.remainingQuantity,
            },
          });
        }
      }

      // If the price level is now empty, remove it from the book entirely
      if (bestLevel.orders.length === 0) {
        if (incomingOrder.side === 'BID') book.removeAskLevel(bestLevel.price);
        else book.removeBidLevel(bestLevel.price);
      }
    }

    // Handle remaining quantity according to order type
    if (remainingQty > 0) {
      incomingOrder.remainingQuantity = remainingQty;
      if (orderType === 'LIMIT') {
        // Rest in book
        book.add(incomingOrder);

        result.events.push({
          eventType: EventType.ORDER_PLACED,
          orderId: incomingOrder.id,
          payload: {
            side: incomingOrder.side,
            price: incomingOrder.price,
            quantity: remainingQty,
          },
        });
      } else {
        // MARKET, IOC, FOK: Cancel unfilled remainder
        result.events.push({
          eventType: EventType.ORDER_CANCELLED,
          orderId: incomingOrder.id,
          payload: {
            side: incomingOrder.side,
            price: incomingOrder.price,
            remainingQuantity: remainingQty,
          },
        });
      }
    }

    return result;
  }

  /**
   * Pre-calculates total fillable quantity across order book levels for FOK verification.
   */
  private static calculateFillableQuantity(
    order: Order,
    book: OrderBook,
  ): number {
    let fillable = 0;
    const depth = book.getDepth(100);
    const levels = order.side === 'BID' ? depth.asks : depth.bids;

    for (const level of levels) {
      if (order.side === 'BID' && order.price < level.price) break;
      if (order.side === 'ASK' && order.price > level.price) break;

      fillable += level.quantity;
      if (fillable >= order.initialQuantity) break;
    }

    return fillable;
  }
}
