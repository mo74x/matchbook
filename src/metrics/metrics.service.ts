import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  private ordersProcessed = 0;
  private tradesExecuted = 0;
  private totalProcessingTimeMs = 0;

  incrementOrdersProcessed() {
    this.ordersProcessed++;
  }

  incrementTrades(count: number = 1) {
    this.tradesExecuted += count;
  }

  recordProcessingTime(durationMs: number) {
    this.totalProcessingTimeMs += durationMs;
  }

  getMetricsString(): string {
    const avgLatency =
      this.ordersProcessed > 0
        ? (this.totalProcessingTimeMs / this.ordersProcessed).toFixed(2)
        : 0;

    return [
      '# HELP matchbook_orders_processed_total Total number of orders processed by matching engine',
      '# TYPE matchbook_orders_processed_total counter',
      `matchbook_orders_processed_total ${this.ordersProcessed}`,
      '',
      '# HELP matchbook_trades_executed_total Total number of executed trades',
      '# TYPE matchbook_trades_executed_total counter',
      `matchbook_trades_executed_total ${this.tradesExecuted}`,
      '',
      '# HELP matchbook_order_processing_avg_ms Average order processing duration in milliseconds',
      '# TYPE matchbook_order_processing_avg_ms gauge',
      `matchbook_order_processing_avg_ms ${avgLatency}`,
    ].join('\n');
  }
}
