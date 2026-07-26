// src/benchmark.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MarketRegistryService } from './engine/market-registry/market-registry.service';
import { Order } from './domain/types/order.types';
import { randomUUID } from 'crypto';

async function bootstrap() {
  // Boot the NestJS context without starting the HTTP server
  const app = await NestFactory.createApplicationContext(AppModule);
  const registry = app.get(MarketRegistryService);

  const instrument = 'BTC-USD';
  const TOTAL_ORDERS = 10000;
  const BASE_PRICE = 50000;

  console.log(`\n🚀 Generating ${TOTAL_ORDERS} synthetic orders...`);

  const orders: Order[] = [];
  for (let i = 0; i < TOTAL_ORDERS; i++) {
    // Randomize side, price, and quantity
    const isBid = Math.random() > 0.5;
    const priceVariance = Math.floor(Math.random() * 100) - 50; // -50 to +50

    orders.push({
      id: randomUUID(),
      instrument,
      side: isBid ? 'BID' : 'ASK',
      price: BASE_PRICE + priceVariance,
      initialQuantity: Math.floor(Math.random() * 5) + 1,
      remainingQuantity: 0, // Set in the next step
      timestamp: Date.now(),
    });
  }

  // Set remaining quantities
  orders.forEach((o) => (o.remainingQuantity = o.initialQuantity));

  console.log(`🔥 Firing ${TOTAL_ORDERS} concurrent orders at the engine...`);

  const startTime = Date.now();

  // Fire all orders concurrently.
  // This heavily tests our MarketProcessor's async queue.
  const promises = orders.map((order) => registry.submitOrder(order));

  await Promise.all(promises);

  const endTime = Date.now();
  const durationMs = endTime - startTime;
  const ops = Math.floor((TOTAL_ORDERS / durationMs) * 1000);

  console.log(`\n✅ Benchmark Complete`);
  console.log(`-----------------------------------`);
  console.log(`Total Orders:     ${TOTAL_ORDERS}`);
  console.log(`Time Taken:       ${durationMs} ms`);
  console.log(`Throughput:       ${ops} Orders / Second`);

  const book = registry.getOrderBook(instrument);
  console.log(`\nFinal Book State (${instrument}):`);
  console.log(`Best Bid:         ${book.getBestBid()?.price || 'None'}`);
  console.log(`Best Ask:         ${book.getBestAsk()?.price || 'None'}`);
  console.log(`-----------------------------------\n`);

  await app.close();
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
