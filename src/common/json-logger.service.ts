/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { LoggerService, Injectable } from '@nestjs/common';
import { CorrelationContext } from './correlation.context';

@Injectable()
export class JsonLogger implements LoggerService {
  private readonly sampleRate: number;

  constructor(sampleRate: number = 1.0) {
    // In production, sampling rate can be adjusted via env var LOG_SAMPLE_RATE (0.0 to 1.0)
    const envRate = process.env.LOG_SAMPLE_RATE
      ? parseFloat(process.env.LOG_SAMPLE_RATE)
      : sampleRate;
    this.sampleRate = isNaN(envRate) ? 1.0 : envRate;
  }

  log(message: any, context?: string) {
    this.print('INFO', message, context);
  }

  error(message: any, trace?: string, context?: string) {
    // Always print errors regardless of sampling
    this.print('ERROR', message, context, { trace }, true);
  }

  warn(message: any, context?: string) {
    // Always print warnings regardless of sampling
    this.print('WARN', message, context, undefined, true);
  }

  debug(message: any, context?: string) {
    this.print('DEBUG', message, context);
  }

  verbose(message: any, context?: string) {
    this.print('VERBOSE', message, context);
  }

  private print(
    level: string,
    message: any,
    context?: string,
    extra?: Record<string, any>,
    forcePrint: boolean = false,
  ) {
    // Log sampling logic for high-frequency logs in production mode
    if (
      !forcePrint &&
      process.env.NODE_ENV === 'production' &&
      this.sampleRate < 1.0
    ) {
      if (Math.random() > this.sampleRate) {
        return;
      }
    }

    const correlationId = CorrelationContext.getCorrelationId();

    const output = {
      timestamp: new Date().toISOString(),
      level,
      context: context || 'Application',
      correlationId: correlationId || null,
      message: typeof message === 'object' ? message : String(message),
      ...extra,
    };

    console.log(JSON.stringify(output));
  }
}
