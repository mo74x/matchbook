import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly startTime = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'System health check' })
  async checkHealth() {
    let dbStatus = 'DOWN';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbStatus = 'UP';
    } catch {
      dbStatus = 'DOWN';
    }

    return {
      status: dbStatus === 'UP' ? 'OK' : 'DEGRADED',
      database: dbStatus,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
    };
  }
}
