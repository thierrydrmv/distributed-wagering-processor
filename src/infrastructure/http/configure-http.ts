import { randomUUID } from 'node:crypto';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { HttpErrorFilter } from './http-error.filter';

export function configureHttp(app: INestApplication): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incoming = request.header('x-correlation-id');

    if (incoming !== undefined && !/^[A-Za-z0-9:_-]{1,128}$/.test(incoming)) {
      response.status(400).json({
        code: 'INVALID_CORRELATION_ID',
        message: 'Invalid X-Correlation-Id header',
      });

      return;
    }

    const correlationId = incoming ?? randomUUID();

    request.headers['x-correlation-id'] = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);

    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: {
        target: false,
        value: false,
      },
      exceptionFactory: () =>
        new BadRequestException({
          code: 'INVALID_PAYLOAD',
          message: 'Request validation failed',
        }),
    }),
  );

  app.useGlobalFilters(new HttpErrorFilter());
}
