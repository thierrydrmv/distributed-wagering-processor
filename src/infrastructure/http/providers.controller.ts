import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { WageringQueries } from '../database/queries/wagering.queries';
import { ProviderAuthGuard } from './provider-auth.guard';

@Controller('providers')
@UseGuards(ProviderAuthGuard)
export class ProvidersController {
  constructor(private readonly queries: WageringQueries) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  getTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.getTransactionByExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
