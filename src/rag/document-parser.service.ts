import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';

@Injectable()
export class DocumentParserService {
  private readonly logger = new Logger(DocumentParserService.name);

  constructor(private readonly configService: ConfigService) {}

  async parseFile(filePath: string): Promise<Document[]> {
    const parserType =
      this.configService.get<string>('RAG_PARSER')?.toLowerCase() || 'pdf';
    const llamaParseApiKey =
      this.configService.get<string>('LLAMA_PARSE_API_KEY') || '';

    if (parserType === 'llama_parse' && llamaParseApiKey) {
      return this.parseWithLlamaParse(filePath, llamaParseApiKey);
    }

    return this.parseWithPdfLoader(filePath);
  }

  private async parseWithPdfLoader(filePath: string): Promise<Document[]> {
    const loader = new PDFLoader(filePath, { splitPages: true });
    const docs = await loader.load();

    return docs.map(
      (doc) =>
        new Document({
          pageContent: doc.pageContent,
          metadata: {
            ...doc.metadata,
            source: filePath,
          },
        }),
    );
  }

  private async parseWithLlamaParse(
    filePath: string,
    apiKey: string,
  ): Promise<Document[]> {
    this.logger.log(`Parsing "${filePath}" with LlamaParse`);

    // Lazy import avoids loading LlamaParse code when parser is set to local PDF.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LlamaParseReader } = require('@llamaindex/cloud/reader');

    const reader = new LlamaParseReader({
      apiKey,
      resultType: 'markdown',
      parsingInstruction:
        this.configService.get<string>('LLAMA_PARSE_INSTRUCTION') ||
        'Extraia o conteúdo técnico preservando contexto e tabelas importantes.',
      maxTimeout: Number(
        this.configService.get<string>('LLAMA_PARSE_TIMEOUT_MS') || 600000,
      ),
      splitByPage: true,
    });

    let parsedDocs: any[] = [];
    try {
      parsedDocs = await reader.loadData(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `LlamaParse failed for "${filePath}" (${message}). Falling back to PDFLoader.`,
      );
      return this.parseWithPdfLoader(filePath);
    }

    return parsedDocs
      .map((doc: any) => {
        const text = doc?.text || doc?.pageContent || '';

        return new Document({
          pageContent: text,
          metadata: {
            ...(doc?.metadata || {}),
            source: filePath,
          },
        });
      })
      .filter((doc) => doc.pageContent.trim().length > 0);
  }
}
