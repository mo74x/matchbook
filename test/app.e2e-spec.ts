/* eslint-disable @typescript-eslint/no-unsafe-member-access */
jest.mock('../generated/prisma/client.js', () => ({
  PrismaClient: class MockPrismaClient {
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
    $queryRaw = jest.fn().mockResolvedValue([{ 1: 1 }]);
    user = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((args: { data: { email: string } }) =>
          Promise.resolve({
            id: 'user-1',
            email: args.data.email,
            createdAt: new Date(),
          }),
        ),
    };
    orderEvent = {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    };
    orderBookSnapshot = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    };
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;
  let jwtToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    // Obtain JWT token for authenticated endpoints
    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: `trader-${Date.now()}@example.com`,
        password: 'Password123!',
      });
    jwtToken = regRes.body.accessToken as string;
  }, 30000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer()).get('/').expect(200);
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('OK');
        expect(res.body.database).toBe('UP');
      });
  });

  it('/metrics (GET)', () => {
    return request(app.getHttpServer())
      .get('/metrics')
      .expect(200)
      .expect((res) => {
        expect(res.text).toContain('matchbook_orders_processed_total');
      });
  });

  it('/orders/book/BTC-USD (GET)', () => {
    return request(app.getHttpServer())
      .get('/orders/book/BTC-USD')
      .expect(200)
      .expect((res) => {
        expect(res.body.instrument).toBe('BTC-USD');
      });
  });

  it('/orders/book/BTC-USD/depth (GET)', () => {
    return request(app.getHttpServer())
      .get('/orders/book/BTC-USD/depth')
      .expect(200)
      .expect((res) => {
        expect(res.body.instrument).toBe('BTC-USD');
        expect(Array.isArray(res.body.bids)).toBe(true);
        expect(Array.isArray(res.body.asks)).toBe(true);
      });
  });

  it('/orders/mine (GET) without Auth header -> 401 Unauthorized', () => {
    return request(app.getHttpServer()).get('/orders/mine').expect(401);
  });

  it('/orders/my-trades (GET) without Auth header -> 401 Unauthorized', () => {
    return request(app.getHttpServer()).get('/orders/my-trades').expect(401);
  });

  it('/orders (POST) with invalid payload -> 400 Bad Request', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({
        instrument: 'BTC-USD',
        side: 'INVALID_SIDE',
        price: -50,
        quantity: 0,
      })
      .expect(400);
  });

  it('/auth/register (POST)', () => {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: `trader-reg-${Date.now()}@example.com`,
        password: 'Password123!',
      })
      .expect(201)
      .expect((res) => {
        expect(res.body.accessToken).toBeDefined();
      });
  });

  it('Full order lifecycle: submit BID -> crossing ASK -> trade generated -> GET /orders/trades', async () => {
    // 1. Submit resting BID
    const bidRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({ instrument: 'BTC-USD', side: 'BID', price: 50000, quantity: 5 })
      .expect(201);
    expect(bidRes.body.orderId).toBeDefined();

    // 2. Submit crossing ASK
    const askRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({ instrument: 'BTC-USD', side: 'ASK', price: 50000, quantity: 5 })
      .expect(201);

    expect(askRes.body.trades).toHaveLength(1);
    expect(askRes.body.trades[0].quantity).toBe(5);

    // 3. GET /orders/trades
    const tradesRes = await request(app.getHttpServer())
      .get('/orders/trades?instrument=BTC-USD')
      .expect(200);

    expect(Array.isArray(tradesRes.body)).toBe(true);
  });

  it('Cancel flow: submit order -> DELETE /orders/:instrument/:orderId -> cancelled', async () => {
    const placeRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({ instrument: 'BTC-USD', side: 'BID', price: 45000, quantity: 2 })
      .expect(201);

    const orderId = placeRes.body.orderId as string;

    const cancelRes = await request(app.getHttpServer())
      .delete(`/orders/BTC-USD/${orderId}`)
      .set('Authorization', `Bearer ${jwtToken}`)
      .expect(200);

    expect(cancelRes.body.success).toBe(true);
  });

  it('FOK rejection E2E: FOK order with zero liquidity returns 201 with 0 trades', async () => {
    const res = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({
        instrument: 'BTC-USD',
        side: 'BID',
        price: 50000,
        quantity: 100,
        type: 'FOK',
      })
      .expect(201);

    expect(res.body.trades).toHaveLength(0);
  });

  it('Depth aggregation E2E: submitting orders at different price levels reflects in /depth', async () => {
    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({ instrument: 'BTC-USD', side: 'BID', price: 40000, quantity: 10 })
      .expect(201);

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${jwtToken}`)
      .send({ instrument: 'BTC-USD', side: 'BID', price: 41000, quantity: 5 })
      .expect(201);

    const depthRes = await request(app.getHttpServer())
      .get('/orders/book/BTC-USD/depth')
      .expect(200);

    expect(depthRes.body.bids.length).toBeGreaterThanOrEqual(2);
    expect(depthRes.body.bids[0].price).toBeGreaterThan(
      depthRes.body.bids[1].price,
    );
  });
});
