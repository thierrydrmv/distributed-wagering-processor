import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { FinancialMetrics } from './financial-metrics';

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: FinancialMetrics) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (request.path === '/metrics' || request.path.startsWith('/health/')) {
      next();
      return;
    }

    const startedAt = performance.now();

    const method = [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ].includes(request.method)
      ? request.method
      : 'OTHER';

    response.once('finish', () => {
      const durationSeconds = (performance.now() - startedAt) / 1_000;

      this.metrics.httpRequests.inc({
        method,
        status_code: String(response.statusCode),
      });

      this.metrics.httpDuration.observe({ method }, durationSeconds);
    });

    next();
  }
}
