import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor() {
    super('Money operations require matching currencies');
    this.name = 'CurrencyMismatchError';
  }
}

const MoneyDecimal = Decimal.clone({ precision: 40 });

const MAX_AMOUNT = new MoneyDecimal('999999999999999999.99');
const INPUT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const SUPPORTED_CURRENCIES = new Set(['BRL', 'USD', 'EUR', 'GBP']);

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (
      !value.isFinite() ||
      value.decimalPlaces() > 2 ||
      value.abs().greaterThan(MAX_AMOUNT)
    ) {
      throw new InvalidMoneyError('Amount exceeds supported monetary range');
    }

    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    Money.assertCurrency(props.currency);

    if (typeof props.amount !== 'string' || !INPUT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        'Amount must be a non-negative decimal string with exactly two decimal places and at most 18 integer digits',
      );
    }

    return new Money(new MoneyDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan('0');
  }

  isNegative(): boolean {
    return this.value.lessThan('0');
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.isZero() ? '0.00' : this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.toJSON().amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }

  private static assertCurrency(currency: string): void {
    if (!SUPPORTED_CURRENCIES.has(currency)) {
      throw new InvalidMoneyError('Unsupported currency');
    }
  }
}
