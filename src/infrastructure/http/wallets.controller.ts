import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OpenWallet } from '../../application/use-cases/open-wallet';
import { WageringQueries } from '../database/queries/wagering.queries';
import { LedgerQueryDto, OpenWalletDto } from './dto/wagering.dto';
import { ProviderAuthGuard } from './provider-auth.guard';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly queries: WageringQueries,
  ) {}

  @Post()
  create(
    @Body() body: OpenWalletDto,
    @Headers('x-correlation-id') correlationId: string,
  ) {
    return this.openWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId,
    });
  }

  @Get(':walletId')
  getWallet(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  getLedger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.queries.getLedger(walletId, query.limit, query.cursor);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Headers('x-correlation-id') correlationId: string,
  ) {
    return this.queries.reconcile(walletId, correlationId);
  }
}
