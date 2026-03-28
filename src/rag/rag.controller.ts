import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { RagService } from './rag.service';
import { ReindexRagDto } from './dto/reindex-rag.dto';
import { QueryRagDto } from './dto/query-rag.dto';

@Controller('rag')
export class RagController {
  constructor(
    private readonly ragService: RagService,
    private readonly configService: ConfigService,
  ) {}

  @UseGuards(AuthGuard())
  @Post('reindex')
  async reindex(@Body() dto: ReindexRagDto) {
    const adminKey = this.configService.get<string>('RAG_ADMIN_API_KEY');

    if (adminKey && dto.adminKey !== adminKey) {
      throw new ForbiddenException('Admin key inválida');
    }

    return this.ragService.reindexFromStorage(dto.resetCollection ?? true);
  }

  @UseGuards(AuthGuard())
  @Post('context')
  async getContext(@Body() dto: QueryRagDto) {
    return this.ragService.getContextPayload(dto.query, dto.k ?? 3);
  }
}
