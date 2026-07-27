import { Logger } from '@nestjs/common';
import { OrderBook } from '../domain/OrderBook';
import { Order } from '../domain/types/order.types';
import { MatchingEngine, MatchingResult } from '../domain/Engine';
import { EventStoreService } from '../event-store/event-store.service';
import { EventToPersist } from '../domain/types/event.types';

interface OrderCallbacks {
  resolve: (result: MatchingResult) => void;
  reject: (error: any) => void;
}

export class MarketProcessor {
  // The actual state of the market
  public readonly book: OrderBook;

  // The queue to prevent async race conditions
  private orderQueue: Order[] = [];
  private pendingCallbacks = new Map<string, OrderCallbacks>();
  private isProcessing = false;
  private isHalted = false;
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
    if (this.isHalted) {
      return Promise.reject(
        new Error(
          `Market ${this.instrument} is currently halted due to persistence failure.`,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      this.pendingCallbacks.set(order.id, { resolve, reject });
      this.orderQueue.push(order);
      void this.processQueue();
    });
  }

  /**
   * The sequential processing loop.
   */
  private async processQueue() {
    // If already processing or halted, do nothing
    if (this.isProcessing || this.orderQueue.length === 0 || this.isHalted)
      return;

    this.isProcessing = true;

    while (this.orderQueue.length > 0 && !this.isHalted) {
      // Dequeue the oldest order
      const order = this.orderQueue.shift()!;
      const callbacks = this.pendingCallbacks.get(order.id);
      this.pendingCallbacks.delete(order.id);

      try {
        // Run the pure, synchronous matching algorithm
        const result = MatchingEngine.processOrder(order, this.book);

        // Format the events for the database
        const eventsToSave: EventToPersist[] = result.events.map((event) => ({
          instrument: this.instrument,
          eventType: event.eventType,
          orderId: event.orderId,
          payload: event.payload,
        }));

        // Await database persistence
        await this.eventStore.appendEvents(eventsToSave);

        // Resolve the caller waiting for this specific order
        callbacks?.resolve(result);
      } catch (error) {
        this.logger.error(
          `CRITICAL: Persistence failed for order ${order.id} in market ${this.instrument}. Halting market.`,
          error,
        );

        // Circuit breaker: halt market to prevent further divergence
        this.isHalted = true;
        callbacks?.reject(error);

        // Reject all remaining enqueued orders
        while (this.orderQueue.length > 0) {
          const queuedOrder = this.orderQueue.shift()!;
          const cb = this.pendingCallbacks.get(queuedOrder.id);
          this.pendingCallbacks.delete(queuedOrder.id);
          cb?.reject(
            new Error(
              `Market ${this.instrument} was halted due to persistence failure.`,
            ),
          );
        }
      }
    }

    this.isProcessing = false;
  }
}
