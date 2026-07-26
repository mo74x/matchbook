/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
jest.mock('../../generated/prisma/client.js', () => ({
  PrismaClient: class MockPrismaClient {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { EventStoreService } from './event-store.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventType } from '../../generated/prisma/enums';

const INSTRUMENT = 'BTC-USD';
let seqCounter = 1n;

/** Builds a fake DB-row shaped event (what findMany returns). */
const dbEvent = (
  eventType: EventType,
  orderId: string,
  payload: Record<string, unknown>,
) => ({
  sequenceId: seqCounter++,
  instrument: INSTRUMENT,
  eventType,
  orderId,
  payload,
  createdAt: new Date(),
});

describe('EventStoreService', () => {
  let service: EventStoreService;
  let prisma: { orderEvent: { createMany: jest.Mock; findMany: jest.Mock } };

  beforeEach(async () => {
    seqCounter = 1n;

    prisma = {
      orderEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventStoreService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<EventStoreService>(EventStoreService);
  });

  describe('appendEvents', () => {
    it('should skip the database call when the array is empty', async () => {
      await service.appendEvents([]);
      expect(prisma.orderEvent.createMany).not.toHaveBeenCalled();
    });

    it('should batch-insert events via createMany', async () => {
      const events = [
        {
          instrument: INSTRUMENT,
          eventType: EventType.ORDER_PLACED,
          orderId: 'order-1',
          payload: { side: 'BID', price: 50000, quantity: 10 },
        },
        {
          instrument: INSTRUMENT,
          eventType: EventType.ORDER_PLACED,
          orderId: 'order-2',
          payload: { side: 'ASK', price: 51000, quantity: 5 },
        },
      ];

      await service.appendEvents(events);

      expect(prisma.orderEvent.createMany).toHaveBeenCalledTimes(1);
      const call = prisma.orderEvent.createMany.mock.calls[0][0];
      expect(call.data).toHaveLength(2);
      expect(call.data[0]).toEqual({
        instrument: INSTRUMENT,
        eventType: EventType.ORDER_PLACED,
        orderId: 'order-1',
        payload: { side: 'BID', price: 50000, quantity: 10 },
      });
    });
  });

  describe('recoverOrderBook', () => {
    it('should return an empty book when there are no events', async () => {
      const book = await service.recoverOrderBook(INSTRUMENT);

      expect(book.instrument).toBe(INSTRUMENT);
      expect(book.getBestBid()).toBeUndefined();
      expect(book.getBestAsk()).toBeUndefined();
    });

    it('should replay ORDER_PLACED events to rebuild resting orders', async () => {
      prisma.orderEvent.findMany.mockResolvedValue([
        dbEvent(EventType.ORDER_PLACED, 'bid-1', {
          side: 'BID',
          price: 50000,
          quantity: 10,
        }),
        dbEvent(EventType.ORDER_PLACED, 'ask-1', {
          side: 'ASK',
          price: 51000,
          quantity: 5,
        }),
      ]);

      const book = await service.recoverOrderBook(INSTRUMENT);

      expect(book.getBestBid()?.price).toBe(50000);
      expect(book.getBestBid()?.orders[0].remainingQuantity).toBe(10);
      expect(book.getBestAsk()?.price).toBe(51000);
      expect(book.getBestAsk()?.orders[0].remainingQuantity).toBe(5);
    });

    it('should apply ORDER_PARTIALLY_FILLED to reduce remaining quantity', async () => {
      prisma.orderEvent.findMany.mockResolvedValue([
        dbEvent(EventType.ORDER_PLACED, 'ask-1', {
          side: 'ASK',
          price: 51000,
          quantity: 10,
        }),
        dbEvent(EventType.ORDER_PARTIALLY_FILLED, 'ask-1', {
          remainingQuantity: 6,
        }),
      ]);

      const book = await service.recoverOrderBook(INSTRUMENT);

      expect(book.getOrder('ask-1')?.remainingQuantity).toBe(6);
    });

    it('should apply ORDER_MATCHED and remove the resting order when fully consumed', async () => {
      prisma.orderEvent.findMany.mockResolvedValue([
        dbEvent(EventType.ORDER_PLACED, 'ask-1', {
          side: 'ASK',
          price: 51000,
          quantity: 10,
        }),
        // A match fully consumes the resting order
        dbEvent(EventType.ORDER_MATCHED, 'taker-1', {
          counterpartyOrderId: 'ask-1',
          matchedQuantity: 10,
        }),
      ]);

      const book = await service.recoverOrderBook(INSTRUMENT);

      expect(book.getOrder('ask-1')).toBeUndefined();
      expect(book.getBestAsk()).toBeUndefined();
    });

    it('should apply ORDER_MATCHED and keep the resting order when partially consumed', async () => {
      prisma.orderEvent.findMany.mockResolvedValue([
        dbEvent(EventType.ORDER_PLACED, 'ask-1', {
          side: 'ASK',
          price: 51000,
          quantity: 10,
        }),
        dbEvent(EventType.ORDER_MATCHED, 'taker-1', {
          counterpartyOrderId: 'ask-1',
          matchedQuantity: 3,
        }),
      ]);

      const book = await service.recoverOrderBook(INSTRUMENT);

      expect(book.getOrder('ask-1')?.remainingQuantity).toBe(7);
      expect(book.getBestAsk()?.price).toBe(51000);
    });

    it('should apply ORDER_CANCELLED to remove the order from the book', async () => {
      prisma.orderEvent.findMany.mockResolvedValue([
        dbEvent(EventType.ORDER_PLACED, 'bid-1', {
          side: 'BID',
          price: 50000,
          quantity: 10,
        }),
        dbEvent(EventType.ORDER_CANCELLED, 'bid-1', {}),
      ]);

      const book = await service.recoverOrderBook(INSTRUMENT);

      expect(book.getOrder('bid-1')).toBeUndefined();
      expect(book.getBestBid()).toBeUndefined();
    });

    it('should replay a complex multi-event scenario correctly', async () => {
      prisma.orderEvent.findMany.mockResolvedValue([
        // Two resting ASKs
        dbEvent(EventType.ORDER_PLACED, 'ask-1', {
          side: 'ASK',
          price: 50000,
          quantity: 10,
        }),
        dbEvent(EventType.ORDER_PLACED, 'ask-2', {
          side: 'ASK',
          price: 50500,
          quantity: 5,
        }),
        // A BID rests
        dbEvent(EventType.ORDER_PLACED, 'bid-1', {
          side: 'BID',
          price: 49000,
          quantity: 20,
        }),
        // Taker sweeps ask-1 fully
        dbEvent(EventType.ORDER_MATCHED, 'taker-1', {
          counterpartyOrderId: 'ask-1',
          matchedQuantity: 10,
        }),
        // bid-1 gets cancelled
        dbEvent(EventType.ORDER_CANCELLED, 'bid-1', {}),
      ]);

      const book = await service.recoverOrderBook(INSTRUMENT);

      // ask-1 fully consumed → gone
      expect(book.getOrder('ask-1')).toBeUndefined();
      // ask-2 untouched → still resting
      expect(book.getOrder('ask-2')?.remainingQuantity).toBe(5);
      expect(book.getBestAsk()?.price).toBe(50500);
      // bid-1 cancelled → gone
      expect(book.getOrder('bid-1')).toBeUndefined();
      expect(book.getBestBid()).toBeUndefined();
    });

    it('should query findMany with the correct instrument filter and ordering', async () => {
      await service.recoverOrderBook(INSTRUMENT);

      expect(prisma.orderEvent.findMany).toHaveBeenCalledWith({
        where: { instrument: INSTRUMENT },
        orderBy: { sequenceId: 'asc' },
      });
    });
  });
});
