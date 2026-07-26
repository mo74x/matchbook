import { Test, TestingModule } from '@nestjs/testing';
import { MarketRegistryService } from './market-registry.service';

describe('MarketRegistryService', () => {
  let service: MarketRegistryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MarketRegistryService],
    }).compile();

    service = module.get<MarketRegistryService>(MarketRegistryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
