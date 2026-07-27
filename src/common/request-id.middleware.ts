import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { CorrelationContext } from './correlation.context';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const headerRequestId = req.headers['x-request-id'];
    const correlationId =
      (Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId) ||
      randomUUID();

    // Attach correlation ID to response headers
    res.setHeader('x-request-id', correlationId);

    const contextMap = new Map<string, any>();
    contextMap.set('correlationId', correlationId);

    CorrelationContext.run(contextMap, () => {
      next();
    });
  }
}
