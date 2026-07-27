import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly validApiKeys = new Set([
    'test-api-key',
    'admin-api-key',
    process.env.API_KEY || 'default-api-key',
  ]);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = request.headers['x-api-key'] as string | undefined;

    if (!process.env.REQUIRE_API_KEY) {
      return true;
    }

    if (!apiKey || !this.validApiKeys.has(apiKey)) {
      throw new UnauthorizedException('Invalid or missing x-api-key header');
    }

    return true;
  }
}
