import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  PersistenceConflictError,
  WageringError,
} from '../../application/errors/wagering-error';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../../domain/value-objects/money';
import { InvalidWagerTransactionError } from '../../domain/entities/wager-transaction';
import { InvalidWalletOperationError } from '../../domain/entities/wallet';

const transientCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '40001',
  '40P01',
  '55P03',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
]);

const transientNames = new Set([
  'ConnectionException',
  'DeadlockException',
  'LockWaitTimeoutException',
]);

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const correlationId = request.header('x-correlation-id');

    if (error instanceof HttpException) {
      const body = error.getResponse();

      response.status(error.getStatus()).json({
        ...(typeof body === 'string' ? { message: body } : body),
        correlationId,
      });

      return;
    }

    if (error instanceof WageringError) {
      const status =
        error.code === 'WALLET_NOT_FOUND' ||
        error.code === 'TRANSACTION_NOT_FOUND'
          ? 404
          : error.code === 'IDEMPOTENCY_CONFLICT' ||
              error.code === 'EXTERNAL_TRANSACTION_CONFLICT'
            ? 409
            : 400;

      response.status(status).json({
        code: error.code,
        message: error.message,
        correlationId,
      });

      return;
    }

    if (error instanceof PersistenceConflictError) {
      response.status(409).json({
        code: 'PERSISTENCE_CONFLICT',
        message: 'A resource with the same identity already exists',
        correlationId,
      });

      return;
    }

    if (
      error instanceof InvalidMoneyError ||
      error instanceof CurrencyMismatchError ||
      error instanceof InvalidWagerTransactionError ||
      error instanceof InvalidWalletOperationError
    ) {
      response.status(400).json({
        code: 'INVALID_PAYLOAD',
        message: error.message,
        correlationId,
      });

      return;
    }

    const transient =
      error instanceof Error &&
      (transientNames.has(error.name) ||
        ('code' in error &&
          typeof error.code === 'string' &&
          transientCodes.has(error.code)));

    this.logger.error(
      JSON.stringify({
        event: transient
          ? 'http_infrastructure_unavailable'
          : 'http_unexpected_error',
        correlationId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );

    if (transient) {
      response.setHeader('Retry-After', '1');
    }

    response.status(transient ? 503 : 500).json({
      code: transient ? 'INFRASTRUCTURE_UNAVAILABLE' : 'INTERNAL_ERROR',
      message: transient
        ? 'Service temporarily unavailable'
        : 'Unexpected server error',
      correlationId,
    });
  }
}
