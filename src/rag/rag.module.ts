import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { DocumentParserService } from './document-parser.service';
import { AiTelemetryService } from './ai-telemetry.service';

@Module({
  imports: [ConfigModule, PassportModule.register({ defaultStrategy: 'jwt' })],
  controllers: [RagController],
  providers: [RagService, DocumentParserService, AiTelemetryService],
  exports: [RagService, AiTelemetryService],
})
export class RagModule {}
