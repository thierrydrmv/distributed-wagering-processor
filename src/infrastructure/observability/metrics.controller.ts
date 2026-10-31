import { Controller, Get, Logger, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { OutboxMessageRecord } from '../database/entities/outbox-message.record';
import { FinancialMetrics } from './financial-metrics';

@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: FinancialMetrics,
  ) {}

  @Get()
  async getMetrics(
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    await this.collectOutboxMetrics();

    response.setHeader('Content-Type', this.metrics.registry.contentType);

    return this.metrics.registry.metrics();
  }

  private async collectOutboxMetrics(): Promise<void> {
    const em = this.orm.em.fork({
      clear: true,
      useContext: false,
    });

    try {
      const [pending, oldest] = await Promise.all([
        em.count(OutboxMessageRecord, {
          publishedAt: null,
        }),
        em.findOne(
          OutboxMessageRecord,
          { publishedAt: null },
          {
            orderBy: {
              occurredAt: 'asc',
              id: 'asc',
            },
          },
        ),
      ]);

      const ageSeconds = oldest
        ? Math.max(0, (Date.now() - oldest.occurredAt.getTime()) / 1_000)
        : 0;

      this.metrics.outboxPending.set(pending);
      this.metrics.outboxLag.set(ageSeconds);
      this.metrics.outboxCollectionUp.set(1);
    } catch (error: unknown) {
      this.metrics.outboxCollectionUp.set(0);

      this.logger.error({
        event: 'outbox_metrics_collection_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}
