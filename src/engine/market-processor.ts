/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Logger } from '@nestjs/common';
import { OrderBook } from '../domain/OrderBook';
import { Order } from '../domain/types/order.types';
import { MatchingEngine, MatchingResult } from '../domain/Engine';
import { EventStoreService } from '../event-store/event-store.service';

export class MarketProcessor {
  // The actual state of the market
  public readonly book: OrderBook;

  // The queue to prevent async race conditions
  private orderQueue: Order[] = [];
  private isProcessing = false;
  private readonly logger: Logger;

  constructor(
    public readonly instrument: string,
    initialBook: OrderBook,
    private readonly eventStore: EventStoreService,
  ) {
    this.book = initialBook;
    this.logger = new Logger(`${MarketProcessor.name}:${this.instrument}`);
  }

  /**
   * Pushes an order into the queue and triggers processing if idle.
   * Returns a Promise that resolves when THIS order finishes processing.
   */
  public enqueueOrder(order: Order): Promise<MatchingResult> {
    return new Promise((resolve, reject) => {
      // Attach the promise callbacks to the order object temporarily
      // so we can resolve it later when its turn comes.
      (order as any)._resolve = resolve;
      (order as any)._reject = reject;

      this.orderQueue.push(order);
      this.processQueue();
    });
  }

  /**
   * The sequential processing loop.
   */
  private async processQueue() {
    // If already processing, do nothing
    if (this.isProcessing || this.orderQueue.length === 0) return;

    this.isProcessing = true;

    while (this.orderQueue.length > 0) {
      // Dequeue the oldest order
      const order = this.orderQueue.shift()!;
      const resolve = (order as any)._resolve;
      const reject = (order as any)._reject;

      try {
        // Run the pure, synchronous matching algorithm
        const result = MatchingEngine.processOrder(order, this.book);

        // Format the events for the database
        const eventsToSave = result.events.map((event) => ({
          instrument: this.instrument,
          eventType: event.eventType,
          orderId: event.orderId,
          payload: event.payload,
        }));

        //Await database persistence (This is the async boundary!)
        // If the DB fails, an exception is thrown, and the OrderBook state is safe
        // because we can crash and rebuild from the DB later.
        await this.eventStore.appendEvents(eventsToSave);

        // Resolve the HTTP request waiting for this specific order
        resolve(result);
      } catch (error) {
        this.logger.error(`Failed to process order ${order.id}:`, error);
        reject(error);

        // Critical System Failure: If the DB fails but the memory was mutated,
        process.exit(1);
      }
    }

    this.isProcessing = false;
  }
}
