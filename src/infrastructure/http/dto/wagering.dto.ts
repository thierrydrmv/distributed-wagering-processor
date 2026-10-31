import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../../../domain/entities/wager-transaction';

export class MoneyDto {
  @IsString()
  @Matches(/^(0|[1-9]\d{0,17})\.\d{2}$/)
  amount!: string;

  @IsString()
  @IsIn(['BRL', 'USD', 'EUR', 'GBP'])
  currency!: string;
}

export class OpenWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class ProcessWagerDto {
  @IsString()
  @Length(1, 255)
  @Matches(/\S/)
  providerId!: string;

  @IsString()
  @Length(1, 255)
  @Matches(/\S/)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @Length(1, 255)
  @Matches(/\S/)
  roundId!: string;

  @IsString()
  @Length(1, 255)
  @Matches(/\S/)
  gameId!: string;

  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 255)
  @Matches(/\S/)
  referenceExternalTransactionId?: string;
}

export class LedgerQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 2048)
  cursor?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
