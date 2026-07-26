# Matchbook

A real-time order matching engine built with NestJS, PostgreSQL, and WebSockets. Matchbook implements a Price-Time Priority (FIFO) matching algorithm backed by an append-only event store, enabling full crash recovery and deterministic state reconstruction.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [System Design](#system-design)
  - [Order Lifecycle](#order-lifecycle)
  - [Data Flow](#data-flow)
  - [Event Sourcing Model](#event-sourcing-model)
- [Project Structure](#project-structure)
- [Core Components](#core-components)
  - [Domain Layer](#domain-layer)
  - [Engine Layer](#engine-layer)
  - [Event Store](#event-store)
  - [API Layer](#api-layer)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [WebSocket Events](#websocket-events)
- [Getting Started](#getting-started)
- [Running the Benchmark](#running-the-benchmark)
- [Testing](#testing)
- [Technology Stack](#technology-stack)

---

## Architecture Overview

Matchbook follows a layered architecture that separates pure domain logic from infrastructure concerns. The matching engine is a synchronous, deterministic function. All side effects (database writes, WebSocket broadcasts) happen at the boundary, outside the matching loop.

```
+------------------+       +-------------------+       +------------------+
|   API Layer      | ----> |   Engine Layer    | ----> |  Domain Layer    |
|  (HTTP / WS)     |       |  (Orchestration)  |       |  (Pure Logic)    |
+------------------+       +-------------------+       +------------------+
                                    |
                                    v
                           +-------------------+
                           |   Event Store     |
                           |  (PostgreSQL)     |
                           +-------------------+
```

**Key design decisions:**

- The matching algorithm is a pure function with no I/O. It takes an order and a book, returns trades and events.
- The `MarketProcessor` serializes concurrent HTTP requests into a sequential queue, preventing race conditions without locks.
- The event store is append-only. State is never mutated in the database. The in-memory order book is the source of truth at runtime, and the event log is the source of truth at rest.

---

## System Design

### Order Lifecycle

The following diagram traces an order from HTTP ingress through matching and persistence:

```mermaid
sequenceDiagram
    participant Client
    participant Controller as OrdersController
    participant Registry as MarketRegistryService
    participant Processor as MarketProcessor
    participant Engine as MatchingEngine
    participant Book as OrderBook
    participant Store as EventStoreService
    participant Gateway as MarketGateway

    Client->>Controller: POST /orders
    Controller->>Registry: submitOrder(order)
    Registry->>Processor: enqueueOrder(order)
    Note over Processor: Waits in FIFO queue
    Processor->>Engine: processOrder(order, book)
    Engine->>Book: getBestAsk() / getBestBid()
    Engine->>Book: add() / removeOrder()
    Engine-->>Processor: MatchingResult (trades + events)
    Processor->>Store: appendEvents(events)
    Store-->>Processor: persisted
    Processor-->>Registry: MatchingResult
    Registry->>Gateway: broadcastTrades(trades)
    Registry->>Gateway: broadcastBookUpdate(bestBid, bestAsk)
    Registry-->>Controller: MatchingResult
    Controller-->>Client: HTTP 201 (orderId, trades)
```

### Data Flow

The system enforces a strict unidirectional data flow. Mutations flow inward toward the domain. Events flow outward toward persistence and clients.

```mermaid
flowchart LR
    subgraph Ingress
        A[HTTP Request]
    end

    subgraph Processing
        B[MarketProcessor Queue]
        C[MatchingEngine]
        D[OrderBook]
    end

    subgraph Egress
        E[Event Store - PostgreSQL]
        F[WebSocket Broadcast]
        G[HTTP Response]
    end

    A --> B
    B --> C
    C <--> D
    C --> E
    E --> G
    C --> F
```

### Event Sourcing Model

Rather than storing the current state of the order book, Matchbook persists every state transition as an immutable event. On startup, the system replays all events to reconstruct the in-memory order book.

```mermaid
flowchart TD
    subgraph Runtime
        A[Incoming Order]
        B[MatchingEngine.processOrder]
        C[In-Memory OrderBook]
        D["Events (ORDER_PLACED, ORDER_MATCHED, ...)"]
    end

    subgraph Persistence
        E[PostgreSQL - OrderEvent table]
    end

    subgraph Recovery
        F[Application Startup]
        G[EventStoreService.recoverOrderBook]
        H[Replay events sequentially]
        I[Reconstructed OrderBook]
    end

    A --> B
    B <--> C
    B --> D
    D --> E

    F --> G
    G --> E
    E --> H
    H --> I
```

**Event types and their semantics:**

| Event Type              | Trigger                                  | Payload Contents                                   |
|------------------------|------------------------------------------|-----------------------------------------------------|
| `ORDER_PLACED`         | Order has remaining quantity after match  | side, price, quantity                                |
| `ORDER_MATCHED`        | Two orders cross in price                | counterpartyOrderId, matchedQuantity, matchedPrice, tradeId |
| `ORDER_PARTIALLY_FILLED` | Resting order loses some but not all quantity | filledQuantity, remainingQuantity                  |
| `ORDER_CANCELLED`      | Order removed from book                  | remainingQuantity                                    |

---

## Project Structure

```
matchbook/
|-- prisma/
|   |-- schema.prisma            # Database schema and event store model
|   +-- migrations/              # Prisma migration history
|-- generated/
|   +-- prisma/                  # Auto-generated Prisma client (do not edit)
|-- src/
|   |-- domain/                  # Pure domain logic, no framework dependencies
|   |   |-- Engine.ts            # Price-Time Priority matching algorithm
|   |   |-- Engine.spec.ts       # Unit tests for the matching engine
|   |   |-- OrderBook.ts         # In-memory order book (bids, asks, price levels)
|   |   +-- types/
|   |       |-- order.types.ts   # Order and Trade interfaces
|   |       +-- event.types.ts   # Event payload interfaces and discriminated union
|   |-- engine/                  # Orchestration layer
|   |   |-- market-processor.ts  # Sequential order queue per instrument
|   |   +-- market-registry/
|   |       |-- market-registry.service.ts       # Multi-instrument router and lifecycle manager
|   |       +-- market-registry.service.spec.ts  # Integration tests
|   |-- event-store/
|   |   |-- event-store.service.ts       # Append-only event persistence and state recovery
|   |   +-- event-store.service.spec.ts  # Unit tests
|   |-- api/
|   |   |-- orders.controller.ts    # REST endpoint for order submission and book queries
|   |   |-- market.gateway.ts       # WebSocket gateway for real-time trade and book updates
|   |   +-- dto/
|   |       +-- create-order.dto.ts # Request validation (class-validator)
|   |-- prisma/
|   |   |-- prisma.service.ts       # Prisma client wrapper with driver adapter
|   |   +-- prisma.service.spec.ts
|   |-- app.module.ts            # NestJS root module
|   |-- main.ts                  # Application entrypoint
|   +-- benchmark.ts             # Load testing script (10,000 concurrent orders)
|-- docker-compose.yml           # PostgreSQL container
|-- prisma.config.ts             # Prisma v7 configuration
|-- tsconfig.json                # TypeScript configuration
+-- package.json
```

---

## Core Components

### Domain Layer

The domain layer contains zero framework dependencies. It is pure TypeScript with no I/O.

**OrderBook** (`src/domain/OrderBook.ts`)

The in-memory representation of a single instrument's order book. Internally maintains:

- `bids`: A `Map<number, PriceLevel>` mapping prices to FIFO queues of resting bid orders.
- `asks`: A `Map<number, PriceLevel>` mapping prices to FIFO queues of resting ask orders.
- `orderMap`: A `Map<string, Order>` for O(1) order lookup by ID.

Each `PriceLevel` holds all orders at a specific price, ordered by arrival time (time priority).

**MatchingEngine** (`src/domain/Engine.ts`)

A stateless class with a single static method: `processOrder(incomingOrder, book)`. The algorithm:

1. Find the best counterparty price level (lowest ask for a bid, highest bid for an ask).
2. If prices cross (bid >= ask), iterate the FIFO queue at that price level.
3. For each resting order, calculate the trade quantity as `min(remainingQty, restingOrder.remainingQuantity)`.
4. Execute at the maker's (resting order's) price.
5. Generate `ORDER_MATCHED` and `ORDER_PARTIALLY_FILLED` events.
6. If the resting order is fully consumed, remove it from the book.
7. Repeat until no more price levels cross or the incoming order is fully filled.
8. If the incoming order still has remaining quantity, rest it in the book and emit `ORDER_PLACED`.

The function returns a `MatchingResult` containing all trades and events produced.

### Engine Layer

**MarketProcessor** (`src/engine/market-processor.ts`)

Wraps a single `OrderBook` instance and serializes concurrent order submissions into a sequential queue. This is the critical concurrency boundary:

```
  HTTP Request 1 --\
  HTTP Request 2 ---+--> [ Queue ] --> Process one at a time --> [ OrderBook ]
  HTTP Request 3 --/
```

Each request gets a `Promise` that resolves only when its specific order has been processed. The processing loop:

1. Dequeue the oldest order.
2. Run the synchronous `MatchingEngine.processOrder()`.
3. Await `EventStoreService.appendEvents()` to persist.
4. Resolve the caller's Promise with the result.
5. If the database write fails, terminate the process (`process.exit(1)`) to prevent divergence between memory and disk.

**MarketRegistryService** (`src/engine/market-registry/market-registry.service.ts`)

Manages multiple `MarketProcessor` instances, one per supported instrument. Responsibilities:

- On startup (`onModuleInit`), recovers each instrument's order book from the event store.
- Routes incoming orders to the correct processor by instrument.
- After each order, broadcasts trade and book updates via the WebSocket gateway.

### Event Store

**EventStoreService** (`src/event-store/event-store.service.ts`)

The persistence layer implementing the event sourcing pattern. Two operations:

- `appendEvents(events)`: Batch-inserts domain events into the `OrderEvent` table using `createMany`.
- `recoverOrderBook(instrument)`: Fetches all events for an instrument ordered by `sequenceId`, then replays them through `applyEventToBook()` to reconstruct the in-memory `OrderBook`.

The replay function is a `switch` over `EventType`:

| Event                   | Replay Action                                      |
|------------------------|-----------------------------------------------------|
| `ORDER_PLACED`         | Create an `Order` object and add it to the book      |
| `ORDER_PARTIALLY_FILLED` | Update the resting order's `remainingQuantity`     |
| `ORDER_MATCHED`        | Reduce the counterparty's quantity; remove if zero   |
| `ORDER_CANCELLED`      | Remove the order from the book                       |

### API Layer

**OrdersController** (`src/api/orders.controller.ts`)

REST controller exposing two endpoints (see API Reference below). Validates incoming requests using `class-validator` decorators on `CreateOrderDto`. Generates a UUID for each order, constructs the internal `Order` object, and delegates to `MarketRegistryService`.

**MarketGateway** (`src/api/market.gateway.ts`)

Socket.IO WebSocket gateway. All connected clients join the `market-data` room. After each order is processed, the gateway broadcasts:

- `trades_executed`: Array of trades that just occurred.
- `book_updated`: Current best bid and best ask for the instrument.

The gateway includes null guards for headless execution (benchmarks, tests) where no WebSocket server is running.

---

## Database Schema

A single append-only table stores the complete event history:

```sql
CREATE TABLE "OrderEvent" (
    "sequenceId"  BIGSERIAL     PRIMARY KEY,
    "instrument"  VARCHAR(20)   NOT NULL,
    "eventType"   "EventType"   NOT NULL,
    "orderId"     UUID          NOT NULL,
    "payload"     JSONB         NOT NULL,
    "createdAt"   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX ON "OrderEvent" ("instrument", "sequenceId" ASC);
```

The `sequenceId` provides a globally ordered, gap-free sequence for deterministic replay. The composite index on `(instrument, sequenceId)` optimizes the recovery query.

The `payload` column stores event-specific data as JSONB, allowing each event type to carry different fields without schema changes.

---

## API Reference

### Submit an Order

```
POST /orders
Content-Type: application/json

{
  "instrument": "BTC-USD",
  "side": "BID",
  "price": 50000,
  "quantity": 5
}
```

**Response (200):**

```json
{
  "message": "Order processed successfully",
  "orderId": "a1b2c3d4-...",
  "trades": [
    {
      "id": "e5f6g7h8-...",
      "instrument": "BTC-USD",
      "makerOrderId": "...",
      "takerOrderId": "...",
      "price": 50000,
      "quantity": 2,
      "executedAt": 1753571400000
    }
  ]
}
```

**Validation rules:**

| Field        | Type   | Constraints                  |
|-------------|--------|-------------------------------|
| `instrument` | string | Required, non-empty           |
| `side`       | enum   | Must be `"BID"` or `"ASK"`   |
| `price`      | number | Required, positive            |
| `quantity`   | number | Required, positive integer >= 1 |

### Get Order Book Snapshot

```
GET /orders/book/:instrument
```

**Response (200):**

```json
{
  "instrument": "BTC-USD",
  "bestBid": 50020,
  "bestAsk": 50024
}
```

---

## WebSocket Events

Connect to the WebSocket server at `ws://localhost:3000`. All clients automatically join the `market-data` room.

| Event Name        | Direction      | Payload                                                |
|-------------------|----------------|--------------------------------------------------------|
| `trades_executed` | Server -> Client | Array of `Trade` objects from the latest match         |
| `book_updated`    | Server -> Client | `{ instrument, bestBid, bestAsk }`                     |

---

## Getting Started

### Prerequisites

- Node.js >= 20.19.0
- PostgreSQL 15+ (or use the included Docker Compose file)
- TypeScript >= 5.4.0

### 1. Clone and Install

```bash
git clone https://github.com/mo74x/matchbook.git
cd matchbook
npm install
```

### 2. Start PostgreSQL

Using Docker:

```bash
docker compose up -d
```

Or connect to an existing PostgreSQL instance by editing `.env`:

```env
DATABASE_URL="postgresql://root:password@localhost:5432/matchbook?schema=public"
```

### 3. Run Migrations

```bash
npx prisma generate
npx prisma migrate dev
```

### 4. Start the Application

```bash
npm run start:dev
```

The server starts at `http://localhost:3000`.

---

## Running the Benchmark

The benchmark script fires 10,000 concurrent orders at the BTC-USD market and measures throughput:

```bash
npx ts-node src/benchmark.ts
```

Sample output:

```
Generating 10000 synthetic orders...
Firing 10000 concurrent orders at the engine...

Benchmark Complete
-----------------------------------
Total Orders:     10000
Time Taken:       20302 ms
Throughput:       492 Orders / Second

Final Book State (BTC-USD):
Best Bid:         50020
Best Ask:         50024
-----------------------------------
```

The benchmark uses `createApplicationContext()` (no HTTP or WebSocket server) to isolate engine and database performance.

---

## Testing

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:cov
```

The test suite covers:

- **Engine.spec.ts** - Matching algorithm correctness: full fills, partial fills, no-match resting, price-time priority ordering.
- **event-store.service.spec.ts** - Event persistence and order book recovery.
- **prisma.service.spec.ts** - Database connection lifecycle.
- **app.controller.spec.ts** - Application controller smoke tests.

---

## Technology Stack

| Component         | Technology                        |
|-------------------|-----------------------------------|
| Runtime           | Node.js >= 20.19.0                |
| Framework         | NestJS 11                         |
| Language          | TypeScript 5.x                    |
| Database          | PostgreSQL 15                     |
| ORM               | Prisma 7 with `@prisma/adapter-pg` driver adapter |
| WebSockets        | Socket.IO via `@nestjs/websockets` |
| Validation        | class-validator, class-transformer |
| Containerization  | Docker Compose                    |
| Testing           | Jest, ts-jest                     |
