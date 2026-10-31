import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsISO8601,
  IsObject,
  IsString,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ProcessWagerDto } from '../http/dto/wagering.dto';

export class SqsWagerDataDto extends ProcessWagerDto {
  @IsString()
  @Length(1, 255)
  @Matches(/^\S+$/)
  idempotencyKey!: string;
}

export class SqsWagerMessageDto {
  @IsString()
  @Length(1, 255)
  @Matches(/\S/)
  messageId!: string;

  @IsIn(['WagerTransactionRequested'])
  type!: string;

  @IsISO8601({
    strict: true,
    strictSeparator: true,
  })
  occurredAt!: string;

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[A-Za-z0-9:_-]{1,128}$/)
  correlationId?: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => SqsWagerDataDto)
  data!: SqsWagerDataDto;
}
