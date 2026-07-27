/* eslint-disable @typescript-eslint/no-unused-expressions */
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
  public readonly instrument: string;
  // Maps a price to its corresponding PriceLevel queue
  private bids = new Map<number, PriceLevel>();
  private asks = new Map<number, PriceLevel>();

  // Best price level pointers for O(1) retrieval
  private bestBidPrice: number | null = null;
  private bestAskPrice: number | null = null;

  // Maps Order ID -> Order Object for quick retrieval/mutation
  private orderMap = new Map<string, Order>();

  constructor(instrument: string) {
    this.instrument = instrument;
  }

  /**
   * Removes an empty ask price level from the book.
   */
  public removeAskLevel(price: number): void {
    this.asks.delete(price);
    if (this.bestAskPrice === price) {
      if (this.asks.size === 0) {
        this.bestAskPrice = null;
      } else {
        this.bestAskPrice = Math.min(...Array.from(this.asks.keys()));
      }
    }
  }

  /**
   * Removes an empty bid price level from the book.
   */
  public removeBidLevel(price: number): void {
    this.bids.delete(price);
    if (this.bestBidPrice === price) {
      if (this.bids.size === 0) {
        this.bestBidPrice = null;
      } else {
        this.bestBidPrice = Math.max(...Array.from(this.bids.keys()));
      }
    }
  }

  /**
   * Adds an order to the book.
   */
  public add(order: Order): void {
    const isBid = order.side === 'BID';
    const book = isBid ? this.bids : this.asks;

    if (!book.has(order.price)) {
      book.set(order.price, new PriceLevel(order.price));
    }

    book.get(order.price)!.addOrder(order);

    if (isBid) {
      if (this.bestBidPrice === null || order.price > this.bestBidPrice) {
        this.bestBidPrice = order.price;
      }
    } else {
      if (this.bestAskPrice === null || order.price < this.bestAskPrice) {
        this.bestAskPrice = order.price;
      }
    }

    // Add to lookup map
    this.orderMap.set(order.id, order);
  }

  // Returns an order by its ID
  public getOrder(id: string): Order | undefined {
    return this.orderMap.get(id);
  }

  // Removes an order from the book
  public removeOrder(id: string): void {
    const order = this.orderMap.get(id);
    if (!order) return;

    const book = order.side === 'BID' ? this.bids : this.asks;
    const level = book.get(order.price);

    if (level) {
      level.removeOrder(id);
      if (level.orders.length === 0) {
        order.side === 'BID'
          ? this.removeBidLevel(order.price)
          : this.removeAskLevel(order.price);
      }
    }
    this.orderMap.delete(id);
  }

  /**
   * Returns the best (highest) bid price level in O(1) time, or undefined if empty.
   */
  public getBestBid(): PriceLevel | undefined {
    if (this.bestBidPrice === null) return undefined;
    return this.bids.get(this.bestBidPrice);
  }

  /**
   * Returns the best (lowest) ask price level in O(1) time, or undefined if empty.
   */
  public getBestAsk(): PriceLevel | undefined {
    if (this.bestAskPrice === null) return undefined;
    return this.asks.get(this.bestAskPrice);
  }
}
