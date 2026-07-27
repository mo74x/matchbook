/* eslint-disable @typescript-eslint/no-unsafe-member-access */
jest.mock('../generated/prisma/client.js', () => ({
  PrismaClient: class MockPrismaClient {
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
    $queryRaw = jest.fn().mockResolvedValue([{ 1: 1 }]);
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
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
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
});
