# Matchbook

A real-time order matching engine built with NestJS, PostgreSQL, and WebSockets. Matchbook implements a **Price-Time Priority (FIFO)** matching algorithm backed by an **append-only event store**, enabling full crash recovery and deterministic state reconstruction.

Supports **LIMIT**, **MARKET**, **IOC** (Immediate or Cancel), and **FOK** (Fill or Kill) order types out of the box.

[![CI/CD](https://github.com/mo74x/matchbook/actions/workflows/ci.yml/badge.svg)](https://github.com/mo74x/matchbook/actions/workflows/ci.yml)

### Built With

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?style=for-the-badge&logo=prisma&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?style=for-the-badge&logo=socket.io&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![Prometheus](https://img.shields.io/badge/Prometheus-Metrics-E6522C?style=for-the-badge&logo=prometheus&logoColor=white)
![Grafana](https://img.shields.io/badge/Grafana-Dashboard-F46800?style=for-the-badge&logo=grafana&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Swagger](https://img.shields.io/badge/Swagger-OpenAPI-85EA2D?style=for-the-badge&logo=swagger&logoColor=black)
![Jest](https://img.shields.io/badge/Jest-Tests-C21325?style=for-the-badge&logo=jest&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-CI/CD-2088FF?style=for-the-badge&logo=github-actions&logoColor=white)

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
- [Order Types](#order-types)
- [API Reference](#api-reference)
- [WebSocket Events](#websocket-events)
- [Authentication](#authentication)
- [Observability](#observability)
- [Getting Started](#getting-started)
- [Docker Deployment](#docker-deployment)
- [Running the Benchmark](#running-the-benchmark)
- [Testing](#testing)
- [Configuration](#configuration)
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
- A **circuit breaker** halts trading on any instrument where database persistence fails, preventing memory/disk divergence.

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
    Registry->>Gateway: broadcastDepthUpdate(bids, asks)
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

Rather than storing the current state of the order book, Matchbook persists every state transition as an immutable event. On startup, the system loads the latest **snapshot** (if available) and replays only subsequent events to reconstruct the in-memory order book.

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
        S[PostgreSQL - OrderBookSnapshot table]
    end

    subgraph Recovery
        F[Application Startup]
        G[Load Latest Snapshot]
        H[Replay events after snapshot]
        I[Reconstructed OrderBook]
    end

    A --> B
    B <--> C
    B --> D
    D --> E
    C -.-> S

    F --> G
    G --> H
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
├── .github/
│   └── workflows/
│       └── ci.yml                  # GitHub Actions CI/CD pipeline
├── prisma/
│   ├── schema.prisma               # Database schema (OrderEvent + OrderBookSnapshot)
│   └── migrations/                 # Prisma migration history
├── generated/
│   └── prisma/                     # Auto-generated Prisma client (do not edit)
├── src/
│   ├── adapters/
│   │   └── redis-io.adapter.ts     # Socket.IO Redis adapter for multi-node scaling
│   ├── api/
│   │   ├── orders.controller.ts    # REST: order submission, book, depth, status queries
│   │   ├── trades.controller.ts    # REST: trade history queries
│   │   ├── health.controller.ts    # GET /health system health check
│   │   ├── market.gateway.ts       # WebSocket gateway (trades, book, depth)
│   │   ├── guards/
│   │   │   └── api-key.guard.ts    # x-api-key header authentication guard
│   │   └── dto/
│   │       └── create-order.dto.ts # Request validation + Swagger decorators
│   ├── common/
│   │   └── json-logger.service.ts  # Structured JSON logger for production
│   ├── domain/                     # Pure domain logic, no framework dependencies
│   │   ├── Engine.ts               # Price-Time Priority matching algorithm
│   │   ├── Engine.spec.ts          # Unit tests (LIMIT, MARKET, IOC, FOK, depth)
│   │   ├── OrderBook.ts            # In-memory order book (bids, asks, price levels)
│   │   └── types/
│   │       ├── order.types.ts      # Order, Trade, OrderType interfaces
│   │       └── event.types.ts      # Event payload interfaces and discriminated union
│   ├── engine/                     # Orchestration layer
│   │   ├── market-processor.ts     # Sequential PLACE/CANCEL queue per instrument
│   │   └── market-registry/
│   │       ├── market-registry.service.ts       # Multi-instrument router + lifecycle
│   │       └── market-registry.service.spec.ts  # Integration tests
│   ├── event-store/
│   │   ├── event-store.service.ts       # Event persistence, snapshots, and recovery
│   │   └── event-store.service.spec.ts  # Unit tests
│   ├── metrics/
│   │   ├── metrics.service.ts      # Prometheus-style metrics collector
│   │   └── metrics.controller.ts   # GET /metrics endpoint
│   ├── prisma/
│   │   ├── prisma.service.ts       # Prisma client wrapper with driver adapter
│   │   └── prisma.service.spec.ts
│   ├── app.module.ts               # NestJS root module
│   ├── main.ts                     # Application entrypoint (Swagger, Logger, Redis)
│   └── benchmark.ts                # Load testing script (10,000 concurrent orders)
├── test/
│   ├── app.e2e-spec.ts             # E2E integration tests
│   └── jest-e2e.json               # Jest E2E configuration
├── Dockerfile                      # Multi-stage production Docker build
├── docker-compose.yml              # PostgreSQL + application containers
├── prisma.config.ts                # Prisma v7 configuration
├── tsconfig.json                   # TypeScript configuration
└── package.json
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
- `getDepth(depth)`: Returns aggregated L2 price level snapshots (bids descending, asks ascending).

Each `PriceLevel` holds all orders at a specific price, ordered by arrival time (time priority).

**MatchingEngine** (`src/domain/Engine.ts`)

A stateless class that processes orders against the book. Supports four order types:

| Order Type | Behavior |
|------------|----------|
| `LIMIT`    | Match at limit price or better; rest any unfilled quantity in the book |
| `MARKET`   | Fill at best available price(s); never rest in the book |
| `IOC`      | Fill what's immediately available; cancel any unfilled remainder |
| `FOK`      | Fill the entire quantity or reject immediately — all or nothing |

The matching algorithm:

1. **(FOK only)** Pre-scan the book to verify full fillability before executing.
2. Find the best counterparty price level (lowest ask for a bid, highest bid for an ask).
3. If prices cross (bid >= ask), iterate the FIFO queue at that price level.
4. For each resting order, calculate the trade quantity as `min(remainingQty, restingOrder.remainingQuantity)`.
5. Execute at the maker's (resting order's) price.
6. Generate `ORDER_MATCHED` and `ORDER_PARTIALLY_FILLED` events.
7. If the resting order is fully consumed, remove it from the book.
8. Repeat until no more price levels cross or the incoming order is fully filled.
9. **(LIMIT only)** If the incoming order still has remaining quantity, rest it in the book and emit `ORDER_PLACED`.

The function returns a `MatchingResult` containing all trades and events produced.

### Engine Layer

**MarketProcessor** (`src/engine/market-processor.ts`)

Wraps a single `OrderBook` instance and serializes concurrent submissions into a sequential task queue. Supports both `PLACE` and `CANCEL` tasks. This is the critical concurrency boundary:

```
  HTTP Request 1 --\
  HTTP Request 2 ---+--> [ Queue ] --> Process one at a time --> [ OrderBook ]
  HTTP Request 3 --/
```

Each request gets a `Promise` that resolves only when its specific task has been processed. The processing loop:

1. Dequeue the oldest task.
2. Run the synchronous `MatchingEngine.processOrder()` or `OrderBook.removeOrder()`.
3. Await `EventStoreService.appendEvents()` to persist.
4. Resolve the caller's Promise with the result.
5. If the database write fails, **halt the market** (circuit breaker) and reject all pending tasks.

**MarketRegistryService** (`src/engine/market-registry/market-registry.service.ts`)

Manages multiple `MarketProcessor` instances, one per supported instrument. Responsibilities:

- On startup (`onModuleInit`), recovers each instrument's order book from the event store (snapshot + replay).
- Routes incoming orders and cancellations to the correct processor by instrument.
- After each order, broadcasts trade, book, and depth updates via the WebSocket gateway.

### Event Store

**EventStoreService** (`src/event-store/event-store.service.ts`)

The persistence layer implementing the event sourcing pattern with snapshot support:

- `appendEvents(events)`: Batch-inserts domain events into the `OrderEvent` table using `createMany`.
- `recoverOrderBook(instrument)`: Loads the latest `OrderBookSnapshot`, then replays only events after the snapshot's `lastSequence` to reconstruct the in-memory `OrderBook`.
- `createSnapshot(instrument, book)`: Persists the current order book state for faster future recovery.
- `getTrades()`: Returns trade history from matched events.
- `getOrderStatus(orderId)`: Returns the full event history for a given order.

The replay function is a `switch` over `EventType`:

| Event                   | Replay Action                                      |
|------------------------|------------------------------------------------------|
| `ORDER_PLACED`         | Create an `Order` object and add it to the book      |
| `ORDER_PARTIALLY_FILLED` | Update the resting order's `remainingQuantity`     |
| `ORDER_MATCHED`        | Reduce the counterparty's quantity; remove if zero   |
| `ORDER_CANCELLED`      | Remove the order from the book                       |

### API Layer

**OrdersController** (`src/api/orders.controller.ts`)

REST controller exposing order submission, cancellation, book queries, depth queries, and order status lookups. All endpoints are documented with Swagger decorators. Validates incoming requests using `class-validator` decorators on `CreateOrderDto`.

**TradesController** (`src/api/trades.controller.ts`)

REST controller exposing trade history via `GET /trades`.

**MarketGateway** (`src/api/market.gateway.ts`)

Socket.IO WebSocket gateway. All connected clients join the `market-data` room. After each order is processed, the gateway broadcasts:

- `trades_executed`: Array of trades that just occurred.
- `book_updated`: Current best bid and best ask for the instrument.
- `depth_updated`: Full L2 book depth (aggregated price level arrays).

The gateway includes null guards for headless execution (benchmarks, tests) where no WebSocket server is running.

---

## Database Schema

Two tables support the event sourcing model:

### OrderEvent

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

### OrderBookSnapshot

```sql
CREATE TABLE "OrderBookSnapshot" (
    "id"           SERIAL        PRIMARY KEY,
    "instrument"   VARCHAR(20)   NOT NULL,
    "lastSequence" BIGINT        NOT NULL,
    "snapshot"     JSONB         NOT NULL,
    "createdAt"    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
```

The `sequenceId` provides a globally ordered, gap-free sequence for deterministic replay. The composite index on `(instrument, sequenceId)` optimizes the recovery query. Snapshots store a serialized order book at a specific sequence point, allowing recovery to skip replaying the full event history.

---

## Order Types

| Type | Requires Price | Rests in Book | Behavior |
|------|:--------------:|:-------------:|----------|
| `LIMIT` | ✅ | ✅ | Standard limit order. Matches at limit price or better, any unfilled portion rests. |
| `MARKET` | ❌ | ❌ | Fills at best available price(s). Any unfilled remainder is cancelled. |
| `IOC` | ✅ | ❌ | Immediate or Cancel. Fills what's immediately available, cancels the rest. |
| `FOK` | ✅ | ❌ | Fill or Kill. Must fill the entire quantity or the order is rejected outright. |

---

## API Reference

> **Interactive API docs**: Swagger UI is available at `http://localhost:3000/api/docs` when the server is running.

### Submit an Order

```
POST /orders
Content-Type: application/json
x-api-key: <your-api-key>

{
  "instrument": "BTC-USD",
  "side": "BID",
  "price": 50000,
  "quantity": 5,
  "type": "LIMIT"
}
```

**Response (201):**

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

| Field        | Type   | Constraints                          |
|-------------|--------|---------------------------------------|
| `instrument` | string | Required, non-empty                   |
| `side`       | enum   | Must be `"BID"` or `"ASK"`           |
| `price`      | number | Required for LIMIT/IOC/FOK, positive  |
| `quantity`   | number | Required, positive integer >= 1       |
| `type`       | enum   | Optional — `"LIMIT"` (default), `"MARKET"`, `"IOC"`, `"FOK"` |

### Cancel an Order

```
DELETE /orders/:instrument/:orderId
x-api-key: <your-api-key>
```

**Response (200):** Confirmation with cancelled order details.

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

### Get L2 Book Depth

```
GET /orders/book/:instrument/depth?depth=10
```

**Response (200):**

```json
{
  "instrument": "BTC-USD",
  "bids": [
    { "price": 50020, "quantity": 15 },
    { "price": 50019, "quantity": 8 }
  ],
  "asks": [
    { "price": 50024, "quantity": 10 },
    { "price": 50025, "quantity": 5 }
  ]
}
```

### Get Order Status

```
GET /orders/:orderId
```

Returns the full event history for the given order.

### Get Trade History

```
GET /trades
```

Returns an array of all executed trades.

### Health Check

```
GET /health
```

**Response (200):**

```json
{
  "status": "OK",
  "uptime": 12345.678,
  "database": "UP"
}
```

### Prometheus Metrics

```
GET /metrics
```

Returns plain-text Prometheus exposition format with counters for `matchbook_orders_processed_total`, `matchbook_trades_executed_total`, and latency histograms.

---

## WebSocket Events

Connect to the WebSocket server at `ws://localhost:3000`. All clients automatically join the `market-data` room.

| Event Name        | Direction        | Payload                                                |
|-------------------|------------------|--------------------------------------------------------|
| `trades_executed` | Server → Client  | Array of `Trade` objects from the latest match         |
| `book_updated`    | Server → Client  | `{ instrument, bestBid, bestAsk }`                     |
| `depth_updated`   | Server → Client  | `{ instrument, bids: [...], asks: [...] }`             |

For horizontal WebSocket scaling across multiple server instances, Matchbook includes a **Redis Socket.IO adapter** (`src/adapters/redis-io.adapter.ts`). Set `USE_REDIS_ADAPTER=true` and configure `REDIS_HOST` / `REDIS_PORT` to enable.

---

## Authentication

Matchbook uses **API key authentication** via the `x-api-key` HTTP header. Set the accepted key using the `API_KEY` environment variable.

```bash
# .env
API_KEY=my-secret-api-key
```

All order mutation endpoints (`POST /orders`, `DELETE /orders/:instrument/:orderId`) are protected. Read-only endpoints (`GET /health`, `GET /metrics`, `GET /orders/book/*`) are publicly accessible.

---

## Observability

| Signal | Endpoint | Description |
|--------|----------|-------------|
| **Health** | `GET /health` | System liveness + database connectivity + uptime |
| **Metrics** | `GET /metrics` | Prometheus-compatible counters, gauges, and histograms (`prom-client`) |
| **Logging** | stdout | Structured JSON logs with AsyncLocalStorage correlation IDs (`x-request-id`) |

### Prometheus Metrics Reference

Matchbook exposes application metrics at `GET /metrics` in standard OpenMetrics exposition format:

| Metric Name | Type | Description |
|-------------|------|-------------|
| `matchbook_orders_processed_total` | Counter | Total orders processed by matching engine |
| `matchbook_trades_executed_total` | Counter | Total executed trades |
| `matchbook_order_latency_seconds` | Histogram | Order processing duration in seconds (by `order_type`: LIMIT/MARKET/IOC/FOK) |
| `matchbook_book_depth` | Gauge | Active price levels per side (`BID`/`ASK`) per instrument |
| `matchbook_ws_connections_active` | Gauge | Current active WebSocket client connections |
| `matchbook_db_query_duration_seconds` | Histogram | Database query duration in seconds (by `operation`) |
| `matchbook_market_halted` | Gauge | Market halted status (1 = halted, 0 = active per `instrument`) |

### Prometheus & Grafana Monitoring Stack

Matchbook includes complete Grafana dashboard provisioning (`grafana/dashboards/matchbook.json`) and automated Prometheus scraping configuration:

```bash
# Start Matchbook + PostgreSQL + Prometheus (9090) + Grafana (3001)
docker compose up -d
```

- **Prometheus UI**: `http://localhost:9090` (scrapes `app:3000/metrics` every 5s)
- **Grafana Dashboard**: `http://localhost:3001` (login: `admin` / `admin`)

The provisioned Grafana dashboard visualizes:
1. **Order Throughput**: Real-time order rate per second (`rate(matchbook_orders_processed_total[1m])`)
2. **Trade Execution Rate**: Trades matched per second (`rate(matchbook_trades_executed_total[1m])`)
3. **Latency Percentiles**: Real-time p50, p95, p99 order execution latencies
4. **Order Book Depth**: Active price level depth curves by instrument and side
5. **WebSocket Connections**: Active WebSocket clients connected (`matchbook_ws_connections_active`)
6. **Market Halted Status**: Circuit breaker status per market (`matchbook_market_halted`)
7. **Database Query Durations**: Query latency breakdown across event store operations

### Structured Logging & Request Correlation

Matchbook uses `JsonLogger` and Node `AsyncLocalStorage` (`CorrelationContext`) to inject a unique `x-request-id` correlation ID into every log line generated during a request lifecycle:

```json
{
  "timestamp": "2026-07-27T18:43:00.000Z",
  "level": "INFO",
  "context": "OrdersController",
  "correlationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "message": {
    "event": "ORDER_SUBMITTED",
    "orderId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "instrument": "BTC-USD",
    "type": "LIMIT",
    "side": "BID",
    "price": 50000,
    "quantity": 5,
    "latencyMs": 1.25
  }
}
```

- **Request Tracking**: Accepts incoming `x-request-id` headers or generates random UUIDs automatically.
- **Log Sampling**: In production (`NODE_ENV=production`), high-frequency debug/verbose logs can be sampled via `LOG_SAMPLE_RATE=0.1` (e.g. 10% sampling rate). Errors and warnings are always logged at 100%.

### Rate Limiting

All endpoints are protected by `@nestjs/throttler` with a default limit of **100 requests per 60 seconds** per IP. Configure via environment variables:

```bash
THROTTLE_TTL=60000       # Window in milliseconds
THROTTLE_LIMIT=100       # Max requests per window
```

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
docker compose up -d postgres
```

Or connect to an existing PostgreSQL instance by creating a `.env` file:

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

The server starts at `http://localhost:3000`. Swagger docs are available at `http://localhost:3000/api/docs`.

---

## Docker Deployment

Build and run the full stack with Docker Compose:

```bash
docker compose up --build
```

This starts:
- **PostgreSQL 15** with health checks and persistent volume
- **Matchbook application** built via multi-stage Dockerfile (build → production)

The multi-stage Dockerfile produces a minimal production image:

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
# ... installs, generates Prisma, compiles TypeScript

# Stage 2: Production
FROM node:20-alpine AS production
# ... copies only dist/ and node_modules/, runs as non-root
```

---

## Kubernetes & Helm Deployment

Matchbook supports native cloud orchestration on Kubernetes (EKS, GKE, AKS, Minikube, K3s) via Kustomize manifests (`k8s/`) or a production-ready Helm v3 chart (`deploy/helm/matchbook`).

### 1. Deploy via Kustomize (`kubectl`)

```bash
# Apply all manifests (Namespace, ConfigMap, Secrets, Postgres, Redis, App, Service, HPA)
kubectl apply -k k8s/
```

Verify deployment status:

```bash
kubectl get all -n matchbook
```

### 2. Deploy via Helm v3

```bash
# Install or upgrade the Matchbook Helm chart
helm upgrade --install matchbook ./deploy/helm/matchbook \
  --namespace matchbook \
  --create-namespace \
  --set replicaCount=3
```

### Kubernetes Architecture Highlights

- **Liveness & Readiness Probes**: Probes `http://localhost:3000/health` for automatic pod replacement and zero-downtime rolling updates.
- **HorizontalPodAutoscaler (HPA)**: Automatically scales application pods (2 to 10 replicas) based on CPU (>70%) and Memory (>80%) load.
- **StatefulSet Data Persistence**: PostgreSQL data is persisted using Kubernetes `PersistentVolumeClaims` (10Gi volume).
- **Ingress Support**: Helm chart includes optional NGINX Ingress controller template with TLS termination support.

---

## Running the Benchmark

The benchmark script evaluates in-memory matching engine throughput, cancellation performance, and mixed workloads (70% Place / 20% Cancel / 10% Query) with full percentile profiling (p50, p95, p99):

```bash
npm run benchmark
# or: npx ts-node src/benchmark.ts
```

### Benchmark Performance Summary

Results are automatically exported as a JSON artifact to `./benchmark-results.json`:

| Workload | Total Ops | Throughput | p50 Latency | p95 Latency | p99 Latency |
|----------|:---------:|:----------:|:-----------:|:-----------:|:-----------:|
| **Order Placement** | 5,000 | **18,726 ops/sec** | 122.45 ms | 232.04 ms | 238.68 ms |
| **Order Cancellation** | 2,000 | **8,333 ops/sec** | 152.87 ms | 229.17 ms | 232.88 ms |
| **Mixed Workload (70/20/10)** | 3,000 | **9,868 ops/sec** | 159.63 ms | 288.81 ms | 295.25 ms |

```json
{
  "timestamp": "2026-07-27T18:52:04.117Z",
  "environment": "development",
  "placeBenchmark": { "totalOps": 5000, "opsPerSec": 18726, "latencies": { "p50": 122.45, "p95": 232.04, "p99": 238.68 } },
  "cancelBenchmark": { "totalOps": 2000, "opsPerSec": 8333, "latencies": { "p50": 152.87, "p95": 229.17, "p99": 232.88 } },
  "mixedWorkloadBenchmark": { "totalOps": 3000, "opsPerSec": 9868, "latencies": { "p50": 159.63, "p95": 288.81, "p99": 295.25 } }
}
```

---

## Testing

```bash
# Run all unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:cov

# Run E2E integration tests
npm run test:e2e

# Run performance SLA verification gate
npm run test:benchmark-gate
```

The test suite covers:

- **Engine.spec.ts** — Matching algorithm correctness: full fills, partial fills, no-match resting, price-time priority ordering, MARKET/IOC/FOK order types, L2 depth aggregation.
- **event-store.service.spec.ts** — Event persistence, order book recovery from snapshots, and replay correctness.
- **market-registry.service.spec.ts** — Multi-instrument routing and gateway broadcast integration.
- **prisma.service.spec.ts** — Database connection lifecycle.
- **app.controller.spec.ts** — Application controller smoke tests.
- **app.e2e-spec.ts** — Full HTTP E2E tests for health, metrics, order book, and depth endpoints.
- **verify-benchmark-sla.ts** — Performance SLA verification gate checking latency and throughput thresholds.

### CI/CD Pipeline & Performance Gate

The project includes a GitHub Actions workflow (`.github/workflows/ci.yml`) that runs on every push and pull request to `main`:

1. **Checkout** → **Node.js 20 setup** → **`npm ci`**
2. **`npx prisma generate`** — Generate the Prisma client
3. **`npm run lint`** — ESLint
4. **`npm run build`** — TypeScript compilation
5. **`npm test`** — Unit tests
6. **`npm run test:e2e`** — E2E integration tests
7. **`npm run benchmark` & `npm run test:benchmark-gate`** — Runs in-memory performance profiling and fails the build if latency or throughput regresses below SLA limits
8. **Artifact Upload** — Saves `benchmark-results.json` as a CI workflow build artifact

A PostgreSQL 15 service container is provisioned automatically for the CI environment.

---

## Configuration

All configuration is via environment variables. Create a `.env` file in the project root:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `API_KEY` | — | Accepted API key for authenticated endpoints |
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | Set to `production` for JSON logging |
| `LOG_SAMPLE_RATE` | `1.0` | Production log sampling rate (0.0 to 1.0) |
| `USE_REDIS_ADAPTER` | `false` | Enable Redis Socket.IO adapter |
| `REDIS_HOST` | `localhost` | Redis host for Socket.IO adapter |
| `REDIS_PORT` | `6379` | Redis port for Socket.IO adapter |
| `THROTTLE_TTL` | `60000` | Rate limit window in milliseconds |
| `THROTTLE_LIMIT` | `100` | Max requests per rate limit window |

---

## Technology Stack

| Component | Technology | Badge |
|-----------|------------|-------|
| **Runtime** | Node.js >= 20.19.0 | ![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white) |
| **Language** | TypeScript 5.x | ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white) |
| **Framework** | NestJS 11 | ![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs&logoColor=white) |
| **Database** | PostgreSQL 15 | ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?style=flat-square&logo=postgresql&logoColor=white) |
| **ORM** | Prisma 7 (`@prisma/adapter-pg`) | ![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?style=flat-square&logo=prisma&logoColor=white) |
| **WebSockets** | Socket.IO via `@nestjs/websockets` | ![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?style=flat-square&logo=socket.io&logoColor=white) |
| **WS Scaling** | Redis adapter (`@socket.io/redis-adapter`) | ![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white) |
| **Metrics** | Prometheus via `prom-client` | ![Prometheus](https://img.shields.io/badge/Prometheus-Metrics-E6522C?style=flat-square&logo=prometheus&logoColor=white) |
| **Dashboard** | Grafana | ![Grafana](https://img.shields.io/badge/Grafana-Dashboard-F46800?style=flat-square&logo=grafana&logoColor=white) |
| **Validation** | class-validator, class-transformer | ![npm](https://img.shields.io/badge/class--validator-✓-CB3837?style=flat-square&logo=npm&logoColor=white) |
| **API Docs** | Swagger / OpenAPI (`@nestjs/swagger`) | ![Swagger](https://img.shields.io/badge/Swagger-OpenAPI-85EA2D?style=flat-square&logo=swagger&logoColor=black) |
| **Rate Limiting** | `@nestjs/throttler` | ![Shield](https://img.shields.io/badge/Throttler-100_req/min-orange?style=flat-square&logo=nestjs&logoColor=white) |
| **Containerization** | Docker (multi-stage) + Docker Compose | ![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white) |
| **CI/CD** | GitHub Actions | ![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-CI/CD-2088FF?style=flat-square&logo=github-actions&logoColor=white) |
| **Testing** | Jest, ts-jest, Supertest | ![Jest](https://img.shields.io/badge/Jest-Tests-C21325?style=flat-square&logo=jest&logoColor=white) |

---

## License

This project is [UNLICENSED](LICENSE) — proprietary and private.
