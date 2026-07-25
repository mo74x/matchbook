import { Order, Trade } from './types/order.types';
import { EventType } from '../../generated/prisma/enums';
import { OrderBook } from './OrderBook';
import { randomUUID } from 'crypto';

export interface MatchingResult {
  trades: Trade[];
  events: any[]; //properly with our DomainOrderEvent payloads
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

    let remainingQty = incomingOrder.initialQuantity;

    //Attempt to match aggressively against resting orders
    while (remainingQty > 0) {
      // Find the best counterparty price
      const bestLevel =
        incomingOrder.side === 'BID' ? book.getBestAsk() : book.getBestBid();

      // If there's no counterparty, or the prices don't cross, stop matching
      if (!bestLevel) break;
      if (incomingOrder.side === 'BID' && incomingOrder.price < bestLevel.price)
        break;
      if (incomingOrder.side === 'ASK' && incomingOrder.price > bestLevel.price)
        break;

      //We have a price match! Iterate through the FIFO queue at this price level
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

    //If the incoming order still has quantity remaining, add it to the book
    if (remainingQty > 0) {
      incomingOrder.remainingQuantity = remainingQty;
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
    }

    return result;
  }
}
