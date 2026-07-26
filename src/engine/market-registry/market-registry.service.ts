import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventStoreService } from 'src/event-store/event-store.service';
import { MarketProcessor } from '../market-processor';
import { Order } from 'src/domain/types/order.types';

@Injectable()
export class MarketRegistryService implements OnModuleInit {
  private readonly logger = new Logger(MarketRegistryService.name);
  private processors = new Map<string, MarketProcessor>();
  private readonly supportedInstruments = ['BTC-USD', 'ETH-USD'];

  constructor(private readonly eventStore: EventStoreService) {}

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

    return await processor.enqueueOrder(order);
  }

  /**
   * Retrieves the current snapshot of the book for API requests.
   */
  public getOrderBook(instrument: string) {
    const processor = this.processors.get(instrument);
    if (!processor) throw new Error('Market not found');

    return processor.book;
  }
}
