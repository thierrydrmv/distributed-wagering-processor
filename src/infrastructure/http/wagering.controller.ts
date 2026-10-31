import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import type { ProcessWagerResponse } from '../../application/use-cases/process-wager-transaction';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import { ProcessWagerDto } from './dto/wagering.dto';
import { ProviderAuthGuard } from './provider-auth.guard';

const responseStatus: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller('wagering')
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(private readonly processor: ProcessWagerTransaction) {}

  @Post('transactions')
  @HttpCode(200)
  async submit(
    @Body() body: ProcessWagerDto,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProcessWagerResponse> {
    if (
      key === undefined ||
      key.length === 0 ||
      key.length > 255 ||
      /\s/.test(key)
    ) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'A non-empty Idempotency-Key header is required',
      });
    }

    const result = await this.processor.execute({
      ...body,
      idempotencyKey: key,
      correlationId,
    });

    response.status(responseStatus[result.status]);

    return result;
  }
}
