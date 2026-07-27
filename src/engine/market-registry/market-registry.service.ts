import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { EventStoreService } from '../../event-store/event-store.service';
import { MarketProcessor } from '../market-processor';
import { Order } from '../../domain/types/order.types';
import { MarketGateway } from '../../api/market.gateway';
import { MetricsService } from '../../metrics/metrics.service';

@Injectable()
export class MarketRegistryService implements OnModuleInit {
  private readonly logger = new Logger(MarketRegistryService.name);
  private processors = new Map<string, MarketProcessor>();
  private readonly supportedInstruments = ['BTC-USD', 'ETH-USD'];

  constructor(
    private readonly eventStore: EventStoreService,
    private readonly marketGateway: MarketGateway,
    @Optional() private readonly metricsService?: MetricsService,
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
        this.metricsService,
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

    const orderType = order.type || 'LIMIT';
    const start = Date.now();

    const result = await processor.enqueueOrder(order);
    const durationSec = (Date.now() - start) / 1000;

    this.metricsService?.recordOrderLatency(orderType, durationSec);
    this.metricsService?.incrementOrdersProcessed(orderType);

    if (result.trades.length > 0) {
      this.metricsService?.incrementTrades(result.trades.length);
      this.marketGateway.broadcastTrades(result.trades);
    }

    const depth = processor.book.getDepth(100);
    this.metricsService?.setBookDepth(
      order.instrument,
      'BID',
      depth.bids.length,
    );
    this.metricsService?.setBookDepth(
      order.instrument,
      'ASK',
      depth.asks.length,
    );

    const bestBid = processor.book.getBestBid()?.price || null;
    const bestAsk = processor.book.getBestAsk()?.price || null;
    this.marketGateway.broadcastBookUpdate(order.instrument, bestBid, bestAsk);
    this.marketGateway.broadcastDepthUpdate(
      order.instrument,
      processor.book.getDepth(20),
    );

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
  public async cancelOrder(
    instrument: string,
    orderId: string,
    userId?: string,
  ) {
    const processor = this.processors.get(instrument);

    if (!processor) {
      throw new Error(`Market ${instrument} is not supported or not loaded.`);
    }

    const result = await processor.cancelOrder(orderId, userId);

    if (result.success) {
      const depth = processor.book.getDepth(100);
      this.metricsService?.setBookDepth(instrument, 'BID', depth.bids.length);
      this.metricsService?.setBookDepth(instrument, 'ASK', depth.asks.length);

      const bestBid = processor.book.getBestBid()?.price || null;
      const bestAsk = processor.book.getBestAsk()?.price || null;
      this.marketGateway.broadcastBookUpdate(instrument, bestBid, bestAsk);
      this.marketGateway.broadcastDepthUpdate(
        instrument,
        processor.book.getDepth(20),
      );
    }

    return result;
  }
}
