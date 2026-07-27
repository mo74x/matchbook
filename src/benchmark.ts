/* eslint-disable @typescript-eslint/require-await */
process.env.IGNORE_DB_ERRORS = 'true';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MarketRegistryService } from './engine/market-registry/market-registry.service';
import { Order } from './domain/types/order.types';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
}

export interface BenchmarkSectionResult {
  totalOps: number;
  durationMs: number;
  opsPerSec: number;
  latencies: Percentiles;
}

export interface BenchmarkReport {
  timestamp: string;
  environment: string;
  placeBenchmark: BenchmarkSectionResult;
  cancelBenchmark: BenchmarkSectionResult;
  mixedWorkloadBenchmark: BenchmarkSectionResult;
}

function calculatePercentiles(latenciesMs: number[]): Percentiles {
  if (latenciesMs.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const getPercentile = (p: number) => {
    const idx = Math.min(
      Math.floor((p / 100) * sorted.length),
      sorted.length - 1,
    );
    return Number(sorted[idx].toFixed(3));
  };
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  return {
    p50: getPercentile(50),
    p95: getPercentile(95),
    p99: getPercentile(99),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
    avg: Number((sum / sorted.length).toFixed(3)),
  };
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const registry = app.get(MarketRegistryService);

  const instrument = 'BTC-USD';
  const BASE_PRICE = 50000;

  console.log(`\n==================================================`);
  console.log(`🚀 MATCHBOOK ENGINE BENCHMARK SUITE`);
  console.log(`==================================================\n`);

  // ----------------------------------------------------
  // SECTION 1: ORDER PLACE BENCHMARK
  // ----------------------------------------------------
  const PLACE_COUNT = 5000;
  console.log(`[1/3] Generating & firing ${PLACE_COUNT} Place Orders...`);

  const placeOrders: Order[] = [];
  for (let i = 0; i < PLACE_COUNT; i++) {
    const isBid = Math.random() > 0.5;
    const priceVariance = Math.floor(Math.random() * 100) - 50;
    placeOrders.push({
      id: randomUUID(),
      instrument,
      side: isBid ? 'BID' : 'ASK',
      type: 'LIMIT',
      price: BASE_PRICE + priceVariance,
      initialQuantity: Math.floor(Math.random() * 5) + 1,
      remainingQuantity: Math.floor(Math.random() * 5) + 1,
      timestamp: Date.now(),
    });
  }

  const placeLatencies: number[] = [];
  const placeStart = Date.now();

  await Promise.all(
    placeOrders.map(async (order) => {
      const t1 = performance.now();
      await registry.submitOrder(order);
      const t2 = performance.now();
      placeLatencies.push(t2 - t1);
    }),
  );

  const placeEnd = Date.now();
  const placeDurationMs = placeEnd - placeStart;
  const placeOps = Math.floor((PLACE_COUNT / placeDurationMs) * 1000);
  const placePercentiles = calculatePercentiles(placeLatencies);

  console.log(`  ✅ Place Benchmark Complete`);
  console.log(`     Throughput: ${placeOps} ops/sec (${placeDurationMs} ms)`);
  console.log(
    `     p50: ${placePercentiles.p50} ms | p95: ${placePercentiles.p95} ms | p99: ${placePercentiles.p99} ms\n`,
  );

  // ----------------------------------------------------
  // SECTION 2: CANCEL BENCHMARK
  // ----------------------------------------------------
  const CANCEL_COUNT = 2000;
  console.log(`[2/3] Seeding & cancelling ${CANCEL_COUNT} Resting Orders...`);

  const restingOrders: Order[] = [];
  for (let i = 0; i < CANCEL_COUNT; i++) {
    restingOrders.push({
      id: randomUUID(),
      instrument,
      side: 'BID',
      type: 'LIMIT',
      price: 30000 - i, // Non-crossing prices deep in the book
      initialQuantity: 10,
      remainingQuantity: 10,
      timestamp: Date.now(),
    });
  }

  // Seed resting orders
  await Promise.all(restingOrders.map((o) => registry.submitOrder(o)));

  const cancelLatencies: number[] = [];
  const cancelStart = Date.now();

  await Promise.all(
    restingOrders.map(async (order) => {
      const t1 = performance.now();
      await registry.cancelOrder(instrument, order.id);
      const t2 = performance.now();
      cancelLatencies.push(t2 - t1);
    }),
  );

  const cancelEnd = Date.now();
  const cancelDurationMs = cancelEnd - cancelStart;
  const cancelOps = Math.floor((CANCEL_COUNT / cancelDurationMs) * 1000);
  const cancelPercentiles = calculatePercentiles(cancelLatencies);

  console.log(`  ✅ Cancel Benchmark Complete`);
  console.log(`     Throughput: ${cancelOps} ops/sec (${cancelDurationMs} ms)`);
  console.log(
    `     p50: ${cancelPercentiles.p50} ms | p95: ${cancelPercentiles.p95} ms | p99: ${cancelPercentiles.p99} ms\n`,
  );

  // ----------------------------------------------------
  // SECTION 3: MIXED WORKLOAD BENCHMARK (70% Place / 20% Cancel / 10% Query)
  // ----------------------------------------------------
  const MIXED_TOTAL = 3000;
  const MIXED_PLACES = Math.floor(MIXED_TOTAL * 0.7); // 2100
  const MIXED_CANCELS = Math.floor(MIXED_TOTAL * 0.2); // 600
  const MIXED_QUERIES = MIXED_TOTAL - MIXED_PLACES - MIXED_CANCELS; // 300

  console.log(
    `[3/3] Executing Mixed Workload (${MIXED_TOTAL} ops: ${MIXED_PLACES} Places / ${MIXED_CANCELS} Cancels / ${MIXED_QUERIES} Queries)...`,
  );

  // Pre-seed orders for the cancel operations in mixed workload
  const mixedRestingOrders: Order[] = [];
  for (let i = 0; i < MIXED_CANCELS; i++) {
    mixedRestingOrders.push({
      id: randomUUID(),
      instrument,
      side: 'ASK',
      type: 'LIMIT',
      price: 80000 + i,
      initialQuantity: 5,
      remainingQuantity: 5,
      timestamp: Date.now(),
    });
  }
  await Promise.all(mixedRestingOrders.map((o) => registry.submitOrder(o)));

  const mixedPromises: Promise<void>[] = [];
  const mixedLatencies: number[] = [];

  const mixedStart = Date.now();

  // 70% Place promises
  for (let i = 0; i < MIXED_PLACES; i++) {
    const isBid = Math.random() > 0.5;
    const order: Order = {
      id: randomUUID(),
      instrument,
      side: isBid ? 'BID' : 'ASK',
      type: 'LIMIT',
      price: BASE_PRICE + (Math.floor(Math.random() * 50) - 25),
      initialQuantity: Math.floor(Math.random() * 3) + 1,
      remainingQuantity: Math.floor(Math.random() * 3) + 1,
      timestamp: Date.now(),
    };
    mixedPromises.push(
      (async () => {
        const t1 = performance.now();
        await registry.submitOrder(order);
        const t2 = performance.now();
        mixedLatencies.push(t2 - t1);
      })(),
    );
  }

  // 20% Cancel promises
  for (let i = 0; i < MIXED_CANCELS; i++) {
    const targetOrder = mixedRestingOrders[i];
    mixedPromises.push(
      (async () => {
        const t1 = performance.now();
        await registry.cancelOrder(instrument, targetOrder.id);
        const t2 = performance.now();
        mixedLatencies.push(t2 - t1);
      })(),
    );
  }

  // 10% Query promises
  for (let i = 0; i < MIXED_QUERIES; i++) {
    mixedPromises.push(
      (async () => {
        const t1 = performance.now();
        registry.getOrderBook(instrument);
        const t2 = performance.now();
        mixedLatencies.push(t2 - t1);
      })(),
    );
  }

  await Promise.all(mixedPromises);

  const mixedEnd = Date.now();
  const mixedDurationMs = mixedEnd - mixedStart;
  const mixedOps = Math.floor((MIXED_TOTAL / mixedDurationMs) * 1000);
  const mixedPercentiles = calculatePercentiles(mixedLatencies);

  console.log(`  ✅ Mixed Workload Benchmark Complete`);
  console.log(`     Throughput: ${mixedOps} ops/sec (${mixedDurationMs} ms)`);
  console.log(
    `     p50: ${mixedPercentiles.p50} ms | p95: ${mixedPercentiles.p95} ms | p99: ${mixedPercentiles.p99} ms\n`,
  );

  // ----------------------------------------------------
  // REPORT COMPILATION & ARTIFACT GENERATION
  // ----------------------------------------------------
  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    placeBenchmark: {
      totalOps: PLACE_COUNT,
      durationMs: placeDurationMs,
      opsPerSec: placeOps,
      latencies: placePercentiles,
    },
    cancelBenchmark: {
      totalOps: CANCEL_COUNT,
      durationMs: cancelDurationMs,
      opsPerSec: cancelOps,
      latencies: cancelPercentiles,
    },
    mixedWorkloadBenchmark: {
      totalOps: MIXED_TOTAL,
      durationMs: mixedDurationMs,
      opsPerSec: mixedOps,
      latencies: mixedPercentiles,
    },
  };

  const artifactPath = path.join(process.cwd(), 'benchmark-results.json');
  fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`==================================================`);
  console.log(`💾 Saved benchmark results artifact to:`);
  console.log(`   ${artifactPath}`);
  console.log(`==================================================\n`);

  await app.close();
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
