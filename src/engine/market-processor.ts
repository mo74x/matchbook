import { Logger } from '@nestjs/common';
import { OrderBook } from '../domain/OrderBook';
import { Order } from '../domain/types/order.types';
import { MatchingEngine, MatchingResult } from '../domain/Engine';
import { EventStoreService } from '../event-store/event-store.service';
import { EventToPersist } from '../domain/types/event.types';
import { EventType } from '../../generated/prisma/enums';

export interface CancelResult {
  success: boolean;
  orderId: string;
  message?: string;
}

interface TaskCallbacks {
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

type ProcessorTask =
  | { type: 'PLACE'; id: string; order: Order }
  | { type: 'CANCEL'; id: string; orderId: string; userId?: string };

export class MarketProcessor {
  // The actual state of the market
  public readonly book: OrderBook;

  // The queue to prevent async race conditions
  private taskQueue: ProcessorTask[] = [];
  private pendingCallbacks = new Map<string, TaskCallbacks>();
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
      this.taskQueue.push({ type: 'PLACE', id: order.id, order });
      void this.processQueue();
    });
  }

  /**
   * Pushes a cancellation task into the queue.
   */
  public cancelOrder(orderId: string, userId?: string): Promise<CancelResult> {
    if (this.isHalted) {
      return Promise.reject(
        new Error(
          `Market ${this.instrument} is currently halted due to persistence failure.`,
        ),
      );
    }

    const taskId = `cancel-${orderId}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      this.pendingCallbacks.set(taskId, { resolve, reject });
      this.taskQueue.push({ type: 'CANCEL', id: taskId, orderId, userId });
      void this.processQueue();
    });
  }

  /**
   * The sequential processing loop.
   */
  private async processQueue() {
    // If already processing or halted, do nothing
    if (this.isProcessing || this.taskQueue.length === 0 || this.isHalted)
      return;

    this.isProcessing = true;

    while (this.taskQueue.length > 0 && !this.isHalted) {
      // Dequeue the oldest task
      const task = this.taskQueue.shift()!;
      const callbacks = this.pendingCallbacks.get(task.id);
      this.pendingCallbacks.delete(task.id);

      try {
        if (task.type === 'PLACE') {
          // Run the pure, synchronous matching algorithm
          const result = MatchingEngine.processOrder(task.order, this.book);

          // Format the events for the database
          const eventsToSave: EventToPersist[] = result.events.map((event) => ({
            instrument: this.instrument,
            eventType: event.eventType,
            orderId: event.orderId,
            userId: task.order.userId,
            payload: event.payload,
          }));

          // Await database persistence
          await this.eventStore.appendEvents(eventsToSave);

          // Resolve the caller waiting for this specific order
          callbacks?.resolve(result);
        } else if (task.type === 'CANCEL') {
          const restingOrder = this.book.getOrder(task.orderId);
          if (!restingOrder) {
            callbacks?.resolve({
              success: false,
              orderId: task.orderId,
              message: 'Order not found resting in order book',
            });
            continue;
          }

          if (
            task.userId &&
            restingOrder.userId &&
            task.userId !== restingOrder.userId
          ) {
            callbacks?.resolve({
              success: false,
              orderId: task.orderId,
              message: 'Unauthorized: Order belongs to another user',
            });
            continue;
          }

          const { price, side, remainingQuantity } = restingOrder;

          // Remove resting order from in-memory book
          this.book.removeOrder(task.orderId);

          // Persist ORDER_CANCELLED event
          const cancelEvent: EventToPersist = {
            instrument: this.instrument,
            eventType: EventType.ORDER_CANCELLED,
            orderId: task.orderId,
            userId: task.userId || restingOrder.userId,
            payload: {
              price,
              side,
              remainingQuantity,
            },
          };

          await this.eventStore.appendEvents([cancelEvent]);

          callbacks?.resolve({
            success: true,
            orderId: task.orderId,
            message: 'Order cancelled successfully',
          });
        }
      } catch (error) {
        this.logger.error(
          `CRITICAL: Persistence failed for task ${task.id} in market ${this.instrument}. Halting market.`,
          error,
        );

        // Circuit breaker: halt market to prevent further divergence
        this.isHalted = true;
        callbacks?.reject(error);

        // Reject all remaining enqueued tasks
        while (this.taskQueue.length > 0) {
          const queuedTask = this.taskQueue.shift()!;
          const cb = this.pendingCallbacks.get(queuedTask.id);
          this.pendingCallbacks.delete(queuedTask.id);
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
