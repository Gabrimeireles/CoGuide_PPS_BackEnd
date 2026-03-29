import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type TelemetryPayload = {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class AiTelemetryService {
  private readonly logger = new Logger(AiTelemetryService.name);
  private langfuseClient: any | null = null;

  constructor(private readonly configService: ConfigService) {}

  private getLangfuseClient(): any | null {
    if (this.langfuseClient !== null) {
      return this.langfuseClient;
    }

    const publicKey = this.configService.get<string>('LANGFUSE_PUBLIC_KEY');
    const secretKey = this.configService.get<string>('LANGFUSE_SECRET_KEY');
    const baseUrl =
      this.configService.get<string>('LANGFUSE_BASE_URL') ||
      'https://cloud.langfuse.com';

    if (!publicKey || !secretKey) {
      this.langfuseClient = null;
      return null;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Langfuse } = require('langfuse');
      this.langfuseClient = new Langfuse({
        publicKey,
        secretKey,
        baseUrl,
      });
      return this.langfuseClient;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Langfuse disabled: ${message}`);
      this.langfuseClient = null;
      return null;
    }
  }

  async trace<T>(
    traceName: string,
    payload: TelemetryPayload,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const client = this.getLangfuseClient();

    try {
      const result = await fn();
      const latencyMs = Date.now() - startedAt;

      this.logger.log(`${traceName} completed in ${latencyMs}ms`);

      if (client) {
        client.trace({
          name: traceName,
          input: payload.input,
          output: payload.output ?? result,
          metadata: {
            ...(payload.metadata || {}),
            latencyMs,
          },
        });
      }

      return result;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(`${traceName} failed in ${latencyMs}ms: ${message}`);

      if (client) {
        client.trace({
          name: `${traceName}_error`,
          input: payload.input,
          output: { error: message },
          metadata: {
            ...(payload.metadata || {}),
            latencyMs,
          },
        });
      }

      throw error;
    }
  }
}
