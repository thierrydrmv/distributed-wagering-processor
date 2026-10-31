import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { OpenWallet } from '../../application/use-cases/open-wallet';
import type { OpenWalletResponse } from '../../application/use-cases/open-wallet';
import { OpenWalletDto } from './dto/wagering.dto';
import { ProviderAuthGuard } from './provider-auth.guard';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(private readonly openWallet: OpenWallet) {}

  @Post()
  create(
    @Body() body: OpenWalletDto,
    @Headers('x-correlation-id') correlationId: string,
  ): Promise<OpenWalletResponse> {
    return this.openWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId,
    });
  }
}
