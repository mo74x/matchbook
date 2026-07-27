import { MarketProcessor } from './market-processor';
import { OrderBook } from '../domain/OrderBook';
import { EventStoreService } from '../event-store/event-store.service';
import { Order } from '../domain/types/order.types';

describe('MarketProcessor (Resilience & Circuit Breaker)', () => {
  let processor: MarketProcessor;
  let book: OrderBook;
  let eventStore: { appendEvents: jest.Mock };

  beforeEach(() => {
    book = new OrderBook('BTC-USD');
    eventStore = {
      appendEvents: jest.fn().mockResolvedValue(undefined),
    };
    processor = new MarketProcessor(
      'BTC-USD',
      book,
      eventStore as unknown as EventStoreService,
    );
  });

  const createOrder = (
    id: string,
    side: 'BID' | 'ASK',
    price: number,
    qty: number,
  ): Order => ({
    id,
    instrument: 'BTC-USD',
    side,
    price,
    initialQuantity: qty,
    remainingQuantity: qty,
    timestamp: Date.now(),
  });

  it('should process order and persist events via eventStore', async () => {
    const order = createOrder('ord-1', 'BID', 50000, 10);
    const result = await processor.enqueueOrder(order);

    expect(result.events).toHaveLength(1);
    expect(eventStore.appendEvents).toHaveBeenCalledTimes(1);
    expect(processor.book.getBestBid()?.price).toBe(50000);
  });

  it('should cancel resting order successfully', async () => {
    const order = createOrder('ord-1', 'BID', 50000, 10);
    await processor.enqueueOrder(order);

    const cancelResult = await processor.cancelOrder('ord-1');

    expect(cancelResult.success).toBe(true);
    expect(processor.book.getBestBid()).toBeUndefined();
    expect(eventStore.appendEvents).toHaveBeenCalledTimes(2);
  });

  it('should halt market and reject pending/subsequent orders when DB persistence fails', async () => {
    const dbError = new Error('Database connection lost');
    eventStore.appendEvents.mockRejectedValueOnce(dbError);

    const order1 = createOrder('ord-1', 'BID', 50000, 10);
    const order2 = createOrder('ord-2', 'BID', 49000, 5);

    // Enqueue order1 which triggers processing and fails at appendEvents
    const p1 = processor.enqueueOrder(order1);
    const p2 = processor.enqueueOrder(order2);

    await expect(p1).rejects.toThrow('Database connection lost');
    await expect(p2).rejects.toThrow('halted due to persistence failure');

    // Subsequent enqueue attempts should immediately reject
    const order3 = createOrder('ord-3', 'BID', 48000, 2);
    await expect(processor.enqueueOrder(order3)).rejects.toThrow(
      'Market BTC-USD is currently halted due to persistence failure',
    );
  });
});
