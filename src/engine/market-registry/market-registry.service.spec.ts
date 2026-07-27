jest.mock('../../../generated/prisma/client.js', () => ({
  PrismaClient: class MockPrismaClient {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { MarketRegistryService } from './market-registry.service';
import { EventStoreService } from '../../event-store/event-store.service';
import { MarketGateway } from '../../api/market.gateway';
import { OrderBook } from '../../domain/OrderBook';

describe('MarketRegistryService', () => {
  let service: MarketRegistryService;
  let mockEventStore: { recoverOrderBook: jest.Mock; appendEvents: jest.Mock };
  let mockMarketGateway: {
    broadcastTrades: jest.Mock;
    broadcastBookUpdate: jest.Mock;
    broadcastDepthUpdate: jest.Mock;
  };

  beforeEach(async () => {
    mockEventStore = {
      recoverOrderBook: jest
        .fn()
        .mockImplementation((instrument: string) =>
          Promise.resolve(new OrderBook(instrument)),
        ),
      appendEvents: jest.fn().mockResolvedValue(undefined),
    };

    mockMarketGateway = {
      broadcastTrades: jest.fn(),
      broadcastBookUpdate: jest.fn(),
      broadcastDepthUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketRegistryService,
        { provide: EventStoreService, useValue: mockEventStore },
        { provide: MarketGateway, useValue: mockMarketGateway },
      ],
    }).compile();

    service = module.get<MarketRegistryService>(MarketRegistryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should bootstrap markets on module init', async () => {
    await service.onModuleInit();
    expect(mockEventStore.recoverOrderBook).toHaveBeenCalledTimes(2);
    expect(mockEventStore.recoverOrderBook).toHaveBeenCalledWith('BTC-USD');
    expect(mockEventStore.recoverOrderBook).toHaveBeenCalledWith('ETH-USD');
  });
});
