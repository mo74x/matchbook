import { EventType } from '../../generated/prisma/enums';
import { OrderBook } from './OrderBook';
import { MatchingEngine } from './Engine';
import { Order } from './types/order.types';
import { OrderCancelledPayload } from './types/event.types';

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

  it('should return aggregated L2 order book depth sorted correctly', () => {
    book.add(createOrder('b1', 'BID', 50000, 10));
    book.add(createOrder('b2', 'BID', 50000, 5));
    book.add(createOrder('b3', 'BID', 49900, 8));

    book.add(createOrder('a1', 'ASK', 51000, 12));
    book.add(createOrder('a2', 'ASK', 51500, 6));

    const depth = book.getDepth(10);

    // Bids should be sorted descending by price
    expect(depth.bids).toEqual([
      { price: 50000, quantity: 15 },
      { price: 49900, quantity: 8 },
    ]);

    // Asks should be sorted ascending by price
    expect(depth.asks).toEqual([
      { price: 51000, quantity: 12 },
      { price: 51500, quantity: 6 },
    ]);
  });

  it('should process MARKET order matching across multiple price levels without resting', () => {
    book.add(createOrder('a1', 'ASK', 51000, 5));
    book.add(createOrder('a2', 'ASK', 52000, 10));

    const marketBid: Order = {
      ...createOrder('m1', 'BID', 0, 8),
      type: 'MARKET',
    };

    const result = MatchingEngine.processOrder(marketBid, book);

    expect(result.trades.length).toBe(2);
    expect(result.trades[0].price).toBe(51000);
    expect(result.trades[0].quantity).toBe(5);
    expect(result.trades[1].price).toBe(52000);
    expect(result.trades[1].quantity).toBe(3);

    // Should NOT rest in the book
    expect(book.getBestBid()).toBeUndefined();
  });

  it('should process IOC order and cancel remaining unexecuted quantity', () => {
    book.add(createOrder('a1', 'ASK', 51000, 4));

    const iocBid: Order = {
      ...createOrder('ioc1', 'BID', 51000, 10),
      type: 'IOC',
    };

    const result = MatchingEngine.processOrder(iocBid, book);

    expect(result.trades.length).toBe(1);
    expect(result.trades[0].quantity).toBe(4);
    expect(
      result.events.some((e) => e.eventType === EventType.ORDER_CANCELLED),
    ).toBe(true);

    // Remaining 6 should not rest in book
    expect(book.getBestBid()).toBeUndefined();
  });

  it('should process FOK order and kill if total depth is insufficient', () => {
    book.add(createOrder('a1', 'ASK', 51000, 4));

    const fokBid: Order = {
      ...createOrder('fok1', 'BID', 51000, 10),
      type: 'FOK',
    };

    const result = MatchingEngine.processOrder(fokBid, book);

    // Should NOT execute any trades
    expect(result.trades.length).toBe(0);
    expect(result.events.length).toBe(1);
    expect(result.events[0].eventType).toBe(EventType.ORDER_CANCELLED);
    expect(book.getBestAsk()?.orders[0].remainingQuantity).toBe(4);
  });

  it('FOK rejection proof: zero trades and no order book mutation', () => {
    book.add(createOrder('ask1', 'ASK', 50000, 3));
    book.add(createOrder('ask2', 'ASK', 50500, 4));

    const initialAsksDepth = book.getDepth(10).asks;

    const fokOrder: Order = {
      ...createOrder('fok-fail', 'BID', 51000, 10),
      type: 'FOK',
    };

    const result = MatchingEngine.processOrder(fokOrder, book);

    expect(result.trades).toHaveLength(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe(EventType.ORDER_CANCELLED);
    expect(book.getBestBid()).toBeUndefined();
    expect(book.getDepth(10).asks).toEqual(initialAsksDepth);
  });

  it('MARKET on empty book: immediately cancelled with zero trades', () => {
    const marketAsk: Order = {
      ...createOrder('m-ask', 'ASK', 0, 5),
      type: 'MARKET',
    };

    const result = MatchingEngine.processOrder(marketAsk, book);

    expect(result.trades).toHaveLength(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe(EventType.ORDER_CANCELLED);
    expect(
      (result.events[0].payload as OrderCancelledPayload).remainingQuantity,
    ).toBe(5);
    expect(book.getBestAsk()).toBeUndefined();
  });

  it('IOC partial fill proof: trades filled portion and cancels remainder', () => {
    book.add(createOrder('maker-ask', 'ASK', 50000, 3));

    const iocOrder: Order = {
      ...createOrder('ioc-order', 'BID', 50000, 7),
      type: 'IOC',
    };

    const result = MatchingEngine.processOrder(iocOrder, book);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].quantity).toBe(3);

    const cancelEvent = result.events.find(
      (e) => e.eventType === EventType.ORDER_CANCELLED,
    );
    expect(cancelEvent).toBeDefined();
    expect(
      (cancelEvent?.payload as OrderCancelledPayload).remainingQuantity,
    ).toBe(4);
    expect(book.getBestBid()).toBeUndefined();
    expect(book.getBestAsk()).toBeUndefined();
  });

  it('3 resting orders at same price: incoming sweep fills strictly in arrival order', () => {
    const o1 = createOrder('first', 'BID', 50000, 5, 1);
    const o2 = createOrder('second', 'BID', 50000, 5, 2);
    const o3 = createOrder('third', 'BID', 50000, 5, 3);

    MatchingEngine.processOrder(o1, book);
    MatchingEngine.processOrder(o2, book);
    MatchingEngine.processOrder(o3, book);

    const sweepAsk = createOrder('sweep-ask', 'ASK', 50000, 12, 4);
    const result = MatchingEngine.processOrder(sweepAsk, book);

    expect(result.trades).toHaveLength(3);
    expect(result.trades[0].makerOrderId).toBe('first');
    expect(result.trades[0].quantity).toBe(5);

    expect(result.trades[1].makerOrderId).toBe('second');
    expect(result.trades[1].quantity).toBe(5);

    expect(result.trades[2].makerOrderId).toBe('third');
    expect(result.trades[2].quantity).toBe(2);

    expect(book.getBestBid()?.orders[0].id).toBe('third');
    expect(book.getBestBid()?.orders[0].remainingQuantity).toBe(3);
  });
});
