/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { LoggerService, Injectable } from '@nestjs/common';

@Injectable()
export class JsonLogger implements LoggerService {
  log(message: any, context?: string) {
    this.print('INFO', message, context);
  }

  error(message: any, trace?: string, context?: string) {
    this.print('ERROR', message, context, { trace });
  }

  warn(message: any, context?: string) {
    this.print('WARN', message, context);
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
  ) {
    const output = {
      timestamp: new Date().toISOString(),
      level,
      context: context || 'Application',
      message: typeof message === 'object' ? message : String(message),
      ...extra,
    };
    console.log(JSON.stringify(output));
  }
}
