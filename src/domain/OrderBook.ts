/* eslint-disable @typescript-eslint/no-unused-vars */
import { Order } from './types/order.types';
/**
 * A FIFO queue for a specific price level.
 * Stores all orders resting at the exact same price, ordered by arrival time.
 */
class PriceLevel {
  public price: number;
  public orders: Order[] = []; // In a strictly optimized engine, this would be a LinkedList

  constructor(price: number) {
    this.price = price;
  }

  addOrder(order: Order): void {
    this.orders.push(order);
  }

  // Returns the oldest order (Time Priority)
  peek(): Order | undefined {
    return this.orders[0];
  }

  removeOrder(orderId: string): void {
    this.orders = this.orders.filter((o) => o.id !== orderId);
  }
}

/**
 * The in-memory Order Book for a single instrument.
 */
export class OrderBook {
  /**
   * Removes an empty ask price level from the book.
   */
  public removeAskLevel(price: number): void {
    this.asks.delete(price);
  }

  /**
   * Removes an empty bid price level from the book.
   */
  public removeBidLevel(price: number): void {
    this.bids.delete(price);
  }
  public readonly instrument: string;

  // Maps a price to its corresponding PriceLevel queue
  private bids = new Map<number, PriceLevel>();
  private asks = new Map<number, PriceLevel>();

  constructor(instrument: string) {
    this.instrument = instrument;
  }

  /**
   * Adds an order to the book.
   */
  public add(order: Order): void {
    const book = order.side === 'BID' ? this.bids : this.asks;

    if (!book.has(order.price)) {
      book.set(order.price, new PriceLevel(order.price));
    }

    book.get(order.price)!.addOrder(order);
  }

  /**
   * Returns the best (highest) bid price level, or undefined if empty.
   */
  public getBestBid(): PriceLevel | undefined {
    if (this.bids.size === 0) return undefined;
    const highestPrice = Math.max(...Array.from(this.bids.keys()));
    return this.bids.get(highestPrice);
  }

  /**
   * Returns the best (lowest) ask price level, or undefined if empty.
   */
  public getBestAsk(): PriceLevel | undefined {
    if (this.asks.size === 0) return undefined;
    const lowestPrice = Math.min(...Array.from(this.asks.keys()));
    return this.asks.get(lowestPrice);
  }
}
