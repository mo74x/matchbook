/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injectable } from '@nestjs/common';
import {
  Registry,
  Histogram,
  Gauge,
  Counter,
  collectDefaultMetrics,
} from 'prom-client';

@Injectable()
export class MetricsService {
  private readonly registry: Registry;

  public readonly ordersProcessedCounter: Counter<string>;
  public readonly tradesExecutedCounter: Counter<string>;
  public readonly orderLatencyHistogram: Histogram<string>;
  public readonly bookDepthGauge: Gauge<string>;
  public readonly wsConnectionsGauge: Gauge<string>;
  public readonly dbQueryDurationHistogram: Histogram<string>;
  public readonly marketHaltedGauge: Gauge<string>;

  constructor() {
    this.registry = new Registry();

    // Collect default Node.js runtime metrics
    collectDefaultMetrics({ register: this.registry });

    this.ordersProcessedCounter = new Counter({
      name: 'matchbook_orders_processed_total',
      help: 'Total number of orders processed by matching engine',
      registers: [this.registry],
    });

    this.tradesExecutedCounter = new Counter({
      name: 'matchbook_trades_executed_total',
      help: 'Total number of executed trades',
      registers: [this.registry],
    });

    this.orderLatencyHistogram = new Histogram({
      name: 'matchbook_order_latency_seconds',
      help: 'Order execution processing duration in seconds',
      labelNames: ['order_type'],
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.bookDepthGauge = new Gauge({
      name: 'matchbook_book_depth',
      help: 'Number of active order book price levels per side per instrument',
      labelNames: ['instrument', 'side'],
      registers: [this.registry],
    });

    this.wsConnectionsGauge = new Gauge({
      name: 'matchbook_ws_connections_active',
      help: 'Current active WebSocket client connections',
      registers: [this.registry],
    });

    this.dbQueryDurationHistogram = new Histogram({
      name: 'matchbook_db_query_duration_seconds',
      help: 'Database operation duration in seconds',
      labelNames: ['operation'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.marketHaltedGauge = new Gauge({
      name: 'matchbook_market_halted',
      help: 'Market halted state (1 for halted, 0 for active)',
      labelNames: ['instrument'],
      registers: [this.registry],
    });
  }

  incrementOrdersProcessed(orderType: string = 'LIMIT') {
    this.ordersProcessedCounter.inc();
  }

  incrementTrades(count: number = 1) {
    this.tradesExecutedCounter.inc(count);
  }

  recordOrderLatency(orderType: string, durationSeconds: number) {
    this.orderLatencyHistogram.observe(
      { order_type: orderType },
      durationSeconds,
    );
  }

  setBookDepth(instrument: string, side: 'BID' | 'ASK', depth: number) {
    this.bookDepthGauge.set({ instrument, side }, depth);
  }

  incrementWsConnections() {
    this.wsConnectionsGauge.inc();
  }

  decrementWsConnections() {
    this.wsConnectionsGauge.dec();
  }

  setWsConnections(count: number) {
    this.wsConnectionsGauge.set(count);
  }

  recordDbQueryDuration(operation: string, durationSeconds: number) {
    this.dbQueryDurationHistogram.observe({ operation }, durationSeconds);
  }

  setMarketHalted(instrument: string, halted: boolean) {
    this.marketHaltedGauge.set({ instrument }, halted ? 1 : 0);
  }

  async getMetricsString(): Promise<string> {
    return await this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
