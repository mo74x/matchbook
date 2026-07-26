/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { EventType } from '../../generated/prisma/enums';
import { OrderBook } from './OrderBook';
import { MatchingEngine } from './Engine';
import { Order } from './types/order.types';

describe('MatchingEngine', () => {
  let book: OrderBook;

  beforeEach(() => {
    // Reset the book before every test
    book = new OrderBook('BTC-USD');
  });

  const createOrder = (
    id: string,
    side: 'BID' | 'ASK',
    price: number,
    qty: number,
    timeOffset = 0,
  ): Order => ({
    id,
    instrument: 'BTC-USD',
    side,
    price,
    initialQuantity: qty,
    remainingQuantity: qty,
    timestamp: Date.now() + timeOffset,
  });

  it('should add an order to the book if no match exists', () => {
    const order = createOrder('1', 'BID', 50000, 10);
    const result = MatchingEngine.processOrder(order, book);

    expect(result.trades.length).toBe(0);
    expect(result.events.length).toBe(1);
    expect(result.events[0].eventType).toBe(EventType.ORDER_PLACED);
    expect(book.getBestBid()?.price).toBe(50000);
  });

  it('should fully execute an exact match', () => {
    //Place a resting SELL order
    const ask = createOrder('maker-1', 'ASK', 50000, 10);
    MatchingEngine.processOrder(ask, book);

    //Incoming BUY order at the same price and quantity
    const bid = createOrder('taker-1', 'BID', 50000, 10);
    const result = MatchingEngine.processOrder(bid, book);

    expect(result.trades.length).toBe(1);
    expect(result.trades[0].quantity).toBe(10);
    expect(result.trades[0].price).toBe(50000);

    // The book should be empty now
    expect(book.getBestAsk()).toBeUndefined();
    expect(book.getBestBid()).toBeUndefined();
  });

  it('should handle partial fills correctly', () => {
    // Maker is selling 10 BTC
    const ask = createOrder('maker-1', 'ASK', 50000, 10);
    MatchingEngine.processOrder(ask, book);

    // Taker only wants to buy 4 BTC
    const bid = createOrder('taker-1', 'BID', 50000, 4);
    const result = MatchingEngine.processOrder(bid, book);

    expect(result.trades.length).toBe(1);
    expect(result.trades[0].quantity).toBe(4);

    // The book should still have 6 BTC left on the ASK side
    const bestAsk = book.getBestAsk();
    expect(bestAsk).toBeDefined();
    expect(bestAsk?.orders[0].remainingQuantity).toBe(6);
  });

  it('should strictly respect Price-Time Priority', () => {
    // Setup resting ASKS
    const ask1 = createOrder('ask-bad-price', 'ASK', 51000, 10, 1);
    const ask2 = createOrder('ask-good-price-old', 'ASK', 50000, 5, 2); // Best price, arrived first
    const ask3 = createOrder('ask-good-price-new', 'ASK', 50000, 5, 3); // Best price, arrived second

    MatchingEngine.processOrder(ask1, book);
    MatchingEngine.processOrder(ask2, book);
    MatchingEngine.processOrder(ask3, book);

    // Incoming BUY order sweeps the book for 8 BTC
    const bid = createOrder('sweep-bid', 'BID', 52000, 8, 4);
    const result = MatchingEngine.processOrder(bid, book);

    // Should generate 2 trades
    expect(result.trades.length).toBe(2);

    // First trade MUST be against the oldest order at the best price
    expect(result.trades[0].makerOrderId).toBe('ask-good-price-old');
    expect(result.trades[0].quantity).toBe(5);
    expect(result.trades[0].price).toBe(50000);

    // Second trade MUST be against the newer order at the best price
    expect(result.trades[1].makerOrderId).toBe('ask-good-price-new');
    expect(result.trades[1].quantity).toBe(3);
    expect(result.trades[1].price).toBe(50000);

    // Check remaining book state:
    // ask-bad-price should be untouched. ask-good-price-new should have 2 left.
    expect(book.getBestAsk()?.price).toBe(50000);
    expect(book.getBestAsk()?.orders[0].remainingQuantity).toBe(2);
  });
});
