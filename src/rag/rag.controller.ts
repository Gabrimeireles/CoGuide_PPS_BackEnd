import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
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
      throw new ForbiddenException('Admin key invalida');
    }

    const { job, alreadyRunning } = this.ragService.startReindexJob(
      dto.resetCollection ?? true,
    );

    return {
      ...job,
      alreadyRunning,
      message: alreadyRunning ? 'Reindex already running' : 'Reindex started',
    };
  }

  @UseGuards(AuthGuard())
  @Get('reindex/status/:jobId')
  async getReindexStatus(@Param('jobId') jobId: string) {
    const status = this.ragService.getReindexJobStatus(jobId);
    if (!status) {
      throw new NotFoundException('Reindex job not found');
    }
    return status;
  }

  @UseGuards(AuthGuard())
  @Get('reindex/status')
  async getLatestReindexStatus() {
    const latest = this.ragService.getLatestReindexJobStatus();
    if (!latest) {
      throw new NotFoundException('No reindex job found');
    }
    return latest;
  }

  @UseGuards(AuthGuard())
  @Post('context')
  async getContext(@Body() dto: QueryRagDto) {
    return this.ragService.getContextPayload(dto.query, dto.k ?? 3);
  }
}
