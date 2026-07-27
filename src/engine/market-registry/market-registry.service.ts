import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventStoreService } from '../../event-store/event-store.service';
import { MarketProcessor } from '../market-processor';
import { Order } from '../../domain/types/order.types';
import { MarketGateway } from '../../api/market.gateway';

@Injectable()
export class MarketRegistryService implements OnModuleInit {
  private readonly logger = new Logger(MarketRegistryService.name);
  private processors = new Map<string, MarketProcessor>();
  private readonly supportedInstruments = ['BTC-USD', 'ETH-USD'];

  constructor(
    private readonly eventStore: EventStoreService,
    private readonly marketGateway: MarketGateway,
  ) {}

  /**
   * On application startup, recover all supported markets from the DB.
   */
  async onModuleInit() {
    this.logger.log('Bootstrapping markets and recovering state...');

    for (const instrument of this.supportedInstruments) {
      const recoveredBook = await this.eventStore.recoverOrderBook(instrument);

      const processor = new MarketProcessor(
        instrument,
        recoveredBook,
        this.eventStore,
      );
      this.processors.set(instrument, processor);
    }

    this.logger.log('All markets ready for trading.');
  }

  /**
   * Routes an incoming order to the correct instrument processor.
   */
  public async submitOrder(order: Order) {
    const processor = this.processors.get(order.instrument);

    if (!processor) {
      throw new Error(
        `Market ${order.instrument} is not supported or not loaded.`,
      );
    }

    const result = await processor.enqueueOrder(order);

    if (result.trades.length > 0) {
      this.marketGateway.broadcastTrades(result.trades);
    }
    const bestBid = processor.book.getBestBid()?.price || null;
    const bestAsk = processor.book.getBestAsk()?.price || null;
    this.marketGateway.broadcastBookUpdate(order.instrument, bestBid, bestAsk);

    return result;
  }

  /**
   * Retrieves the current snapshot of the book for API requests.
   */
  public getOrderBook(instrument: string) {
    const processor = this.processors.get(instrument);
    if (!processor) throw new Error('Market not found');

    return processor.book;
  }

  /**
   * Routes a cancellation request to the correct instrument processor.
   */
  public async cancelOrder(instrument: string, orderId: string) {
    const processor = this.processors.get(instrument);

    if (!processor) {
      throw new Error(`Market ${instrument} is not supported or not loaded.`);
    }

    const result = await processor.cancelOrder(orderId);

    if (result.success) {
      const bestBid = processor.book.getBestBid()?.price || null;
      const bestAsk = processor.book.getBestAsk()?.price || null;
      this.marketGateway.broadcastBookUpdate(instrument, bestBid, bestAsk);
    }

    return result;
  }
}
