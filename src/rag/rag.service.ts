import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Chroma } from '@langchain/community/vectorstores/chroma';
import { OllamaEmbeddings } from '@langchain/ollama';
import { OpenAIEmbeddings } from '@langchain/openai';
import { ChromaClient } from 'chromadb';
import { Document } from '@langchain/core/documents';
import { DocumentParserService } from './document-parser.service';
import { AiTelemetryService } from './ai-telemetry.service';
import { RagContextResponse } from './types/rag-context.types';

type ReindexResult = {
  filesIndexed: number;
  chunksIndexed: number;
  collection: string;
};

type ReindexJobState = 'running' | 'completed' | 'failed';

export type ReindexJobStatus = {
  jobId: string;
  state: ReindexJobState;
  resetCollection: boolean;
  startedAt: string;
  finishedAt?: string;
  result?: ReindexResult;
  error?: string;
};

@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private vectorStore: Chroma | null = null;
  private readonly reindexJobs = new Map<string, ReindexJobStatus>();
  private activeReindexJobId: string | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly parserService: DocumentParserService,
    private readonly telemetryService: AiTelemetryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initializeVectorStore();

    const autoReindex =
      (this.configService.get<string>('RAG_AUTO_REINDEX') || 'false')
        .toLowerCase()
        .trim() === 'true';

    if (autoReindex) {
      await this.reindexFromStorage(true);
    }
  }

  async getContextPayload(query: string, k = 3): Promise<RagContextResponse> {
    await this.initializeVectorStore();

    if (!this.vectorStore) {
      return {
        query,
        collection: this.getCollectionName(),
        k,
        chunks: [],
        generatedAt: new Date().toISOString(),
      };
    }

    return this.telemetryService.trace(
      'rag_retrieve',
      {
        input: { query, k },
        metadata: { component: 'rag' },
      },
      async (): Promise<RagContextResponse> => {
        const candidateCount = this.getCandidateCount(k);
        const maxDistance = this.getMaxDistance();
        const rawMatches = await this.similaritySearchWithScore(query, candidateCount);
        const rankedPool = this.rankAndFilterMatches(
          rawMatches,
          query,
          Math.max(k * 3, 15),
          maxDistance,
        );
        const matches = this.enrichAndTrimMatches(rankedPool, k);
        const supportPlaybook = this.buildSupportPlaybook(query, matches);
        const retrievalConfidence = this.computeRetrievalConfidence(
          matches.map(([, score]) => score),
          maxDistance,
        );
        const confidenceThreshold = this.getMinConfidenceThreshold();
        const confident = retrievalConfidence >= confidenceThreshold;

        if (!matches.length || !confident) {
          return {
            query,
            collection: this.getCollectionName(),
            k,
            chunks: [],
            retrievalConfidence,
            confidenceThreshold,
            confident,
            generatedAt: new Date().toISOString(),
          };
        }

        const chunks = matches.map(([doc, score], index) => {
          const source = String(doc.metadata?.source || 'unknown');
          const page = doc.metadata?.loc?.pageNumber || doc.metadata?.page || 'n/a';

          return {
            id: String(doc.metadata?.id || randomUUID()),
            content: doc.pageContent,
            score,
            metadata: doc.metadata || {},
            citation: `[${index + 1}] fonte=${source} página=${page} score=${score.toFixed(
              4,
            )}`,
          };
        });

        return {
          query,
          collection: this.getCollectionName(),
          k,
          chunks,
          ...(supportPlaybook.length ? { supportPlaybook } : {}),
          retrievalConfidence,
          confidenceThreshold,
          confident,
          generatedAt: new Date().toISOString(),
        };
      },
    );
  }

  formatContextForPrompt(context: RagContextResponse): string {
    if (!context.chunks.length) {
      return '';
    }

    return context.chunks
      .map((chunk) => [chunk.citation, chunk.content].join('\n'))
      .join('\n\n');
  }

  async reindexFromStorage(resetCollection = true): Promise<ReindexResult> {
    await this.initializeVectorStore();

    if (!this.vectorStore) {
      throw new Error('Vector store not initialized');
    }

    const collection = this.getCollectionName();
    const rawDir = this.getRawDir();

    if (resetCollection) {
      const client = new ChromaClient({ path: this.getChromaUrl() });
      try {
        await client.deleteCollection({ name: collection });
      } catch {
        this.logger.debug(`Collection "${collection}" not found, skipping delete`);
      }
      await this.initializeVectorStore();
    }

    const files = await this.collectFiles(rawDir);
    let chunksIndexed = 0;
    const embedBatchSize = this.getEmbeddingBatchSize();

    for (const filePath of files) {
      const parsedDocs = await this.parserService.parseFile(filePath);
      const chunks = await this.splitDocuments(parsedDocs);
      const ids = chunks.map(() => randomUUID());

      if (chunks.length > 0) {
        for (let i = 0; i < chunks.length; i += embedBatchSize) {
          const docsBatch = chunks.slice(i, i + embedBatchSize);
          const idsBatch = ids.slice(i, i + embedBatchSize);
          await this.vectorStore!.addDocuments(docsBatch, { ids: idsBatch });
        }
        chunksIndexed += chunks.length;
      }
    }

    this.logger.log(
      `RAG index ready. files=${files.length} chunks=${chunksIndexed} collection=${collection}`,
    );

    return {
      filesIndexed: files.length,
      chunksIndexed,
      collection,
    };
  }

  startReindexJob(resetCollection = true): {
    job: ReindexJobStatus;
    alreadyRunning: boolean;
  } {
    if (this.activeReindexJobId) {
      const runningJob = this.reindexJobs.get(this.activeReindexJobId);
      if (runningJob && runningJob.state === 'running') {
        return { job: runningJob, alreadyRunning: true };
      }
      this.activeReindexJobId = null;
    }

    const jobId = randomUUID();
    const job: ReindexJobStatus = {
      jobId,
      state: 'running',
      resetCollection,
      startedAt: new Date().toISOString(),
    };

    this.reindexJobs.set(jobId, job);
    this.activeReindexJobId = jobId;

    void this.runReindexJob(jobId, resetCollection);
    return { job, alreadyRunning: false };
  }

  getReindexJobStatus(jobId: string): ReindexJobStatus | null {
    return this.reindexJobs.get(jobId) ?? null;
  }

  getLatestReindexJobStatus(): ReindexJobStatus | null {
    const latest = Array.from(this.reindexJobs.values()).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    )[0];
    return latest ?? null;
  }

  private async initializeVectorStore(): Promise<void> {
    if (this.vectorStore) {
      return;
    }

    this.vectorStore = new Chroma(this.getEmbeddings(), {
      collectionName: this.getCollectionName(),
      url: this.getChromaUrl(),
    });
  }

  private async runReindexJob(
    jobId: string,
    resetCollection: boolean,
  ): Promise<void> {
    const baseJob =
      this.reindexJobs.get(jobId) ??
      ({
        jobId,
        state: 'running',
        resetCollection,
        startedAt: new Date().toISOString(),
      } as ReindexJobStatus);

    try {
      const result = await this.reindexFromStorage(resetCollection);
      this.reindexJobs.set(jobId, {
        ...baseJob,
        state: 'completed',
        finishedAt: new Date().toISOString(),
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Reindex job ${jobId} failed: ${message}`);
      this.reindexJobs.set(jobId, {
        ...baseJob,
        state: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
      });
    } finally {
      if (this.activeReindexJobId === jobId) {
        this.activeReindexJobId = null;
      }
      this.trimReindexHistory();
    }
  }

  private trimReindexHistory(): void {
    const maxHistory = 20;
    const finishedJobs = Array.from(this.reindexJobs.values())
      .filter((job) => job.state !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    const excess = finishedJobs.length - maxHistory;
    if (excess <= 0) {
      return;
    }

    for (let i = 0; i < excess; i += 1) {
      this.reindexJobs.delete(finishedJobs[i].jobId);
    }
  }

  private getEmbeddings() {
    const provider =
      this.configService.get<string>('RAG_EMBEDDING_PROVIDER') || 'ollama';

    if (provider === 'openai') {
      return new OpenAIEmbeddings({
        model:
          this.configService.get<string>('RAG_OPENAI_EMBEDDING_MODEL') ||
          'text-embedding-3-small',
      });
    }

    return new OllamaEmbeddings({
      model:
        this.configService.get<string>('RAG_OLLAMA_EMBEDDING_MODEL') ||
        'nomic-embed-text',
      baseUrl:
        this.configService.get<string>('OLLAMA_BASE_URL') ||
        'http://localhost:11434',
    });
  }

  private getChromaUrl(): string {
    return this.configService.get<string>('RAG_CHROMA_URL') || 'http://localhost:8000';
  }

  private getCollectionName(): string {
    return this.configService.get<string>('RAG_COLLECTION') || 'rag';
  }

  private getRawDir(): string {
    const configured = this.configService.get<string>('RAG_RAW_DIR');
    if (configured && existsSync(configured)) {
      return configured;
    }

    const rootRaw = join('raw');
    if (existsSync(rootRaw)) {
      if (configured && configured !== rootRaw) {
        this.logger.warn(
          `RAG_RAW_DIR="${configured}" not found. Falling back to "${rootRaw}".`,
        );
      }
      return rootRaw;
    }

    const storageRaw = join('storage', 'raw');
    if (existsSync(storageRaw)) {
      if (configured && configured !== storageRaw) {
        this.logger.warn(
          `RAG_RAW_DIR="${configured}" not found. Falling back to "${storageRaw}".`,
        );
      }
      return storageRaw;
    }

    return configured || rootRaw;
  }

  private async collectFiles(rootDir: string): Promise<string[]> {
    const supported = new Set(['.pdf']);
    const stack = [rootDir];
    const files: string[] = [];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        if (supported.has(extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  private async splitDocuments(docs: Document[]): Promise<Document[]> {
    const chunkSize = Number(this.configService.get<string>('RAG_CHUNK_SIZE') || 2000);
    const chunkOverlap = Number(
      this.configService.get<string>('RAG_CHUNK_OVERLAP') || 100,
    );

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
    });

    return splitter.splitDocuments(docs);
  }

  private getEmbeddingBatchSize(): number {
    const value = Number(
      this.configService.get<string>('RAG_EMBED_BATCH_SIZE') || 64,
    );
    if (!Number.isFinite(value) || value <= 0) {
      return 64;
    }
    return Math.floor(value);
  }

  private getCandidateCount(k: number): number {
    const multiplier = Number(
      this.configService.get<string>('RAG_RETRIEVAL_CANDIDATE_MULTIPLIER') || 10,
    );
    const safeMultiplier =
      Number.isFinite(multiplier) && multiplier >= 1 ? Math.floor(multiplier) : 10;
    return Math.max(k, Math.min(300, k * safeMultiplier));
  }

  private getMaxDistance(): number {
    const value = Number(this.configService.get<string>('RAG_MAX_DISTANCE') || 1.2);
    if (!Number.isFinite(value) || value <= 0) {
      return 1.2;
    }
    return value;
  }

  private async similaritySearchWithScore(
    query: string,
    k: number,
  ): Promise<Array<[Document, number]>> {
    const queryEmbedding = await this.getEmbeddings().embedQuery(query);
    const client = new ChromaClient({ path: this.getChromaUrl() });
    const collection = await client.getOrCreateCollection({
      name: this.getCollectionName(),
    });

    const result = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: k,
    });

    const ids = result.ids?.[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const documents = result.documents?.[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];
    const matches: Array<[Document, number]> = [];

    for (let i = 0; i < ids.length; i += 1) {
      const metadata = this.normalizeMetadata(
        (metadatas[i] as Record<string, unknown>) ?? {},
      );
      matches.push([
        new Document({
          pageContent: documents[i] ?? '',
          metadata,
        }),
        distances[i] ?? 0,
      ]);
    }

    return matches;
  }

  private normalizeMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    const locFrom = metadata.locFrom;
    const locTo = metadata.locTo;

    if (locFrom !== undefined && locTo !== undefined) {
      const normalized: Record<string, unknown> = {
        ...metadata,
        loc: {
          lines: {
            from: locFrom,
            to: locTo,
          },
        },
      };
      delete normalized['locFrom'];
      delete normalized['locTo'];
      return normalized;
    }

    return metadata;
  }

  private rankAndFilterMatches(
    matches: Array<[Document, number]>,
    query: string,
    k: number,
    maxDistance: number,
  ): Array<[Document, number]> {
    const proceduralIntent = this.isProceduralIntent(query);
    const minChunkChars = this.getMinChunkChars();
    const dedup = new Map<string, [Document, number]>();

    for (const [doc, score] of matches) {
      if (!Number.isFinite(score) || score > maxDistance) {
        continue;
      }
      if ((doc.pageContent || '').trim().length < minChunkChars) {
        continue;
      }

      const key = this.buildDedupKey(doc.pageContent);
      const current = dedup.get(key);

      if (!current) {
        dedup.set(key, [doc, score]);
        continue;
      }

      const replacement = this.pickPreferred(current, [doc, score]);
      dedup.set(key, replacement);
    }

    return Array.from(dedup.values())
      .sort((a, b) => {
        const scoreA = this.computeRerankScore(
          query,
          a[0],
          a[1],
          maxDistance,
          proceduralIntent,
        );
        const scoreB = this.computeRerankScore(
          query,
          b[0],
          b[1],
          maxDistance,
          proceduralIntent,
        );
        if (scoreA !== scoreB) {
          return scoreB - scoreA;
        }
        return a[1] - b[1];
      })
      .slice(0, k);
  }

  private enrichAndTrimMatches(
    rankedPool: Array<[Document, number]>,
    k: number,
  ): Array<[Document, number]> {
    const selected = rankedPool.slice(0, k);
    const enriched = selected.map(([doc, score]) => {
      const neighbor = this.findBestNeighbor(doc, rankedPool);
      if (!neighbor) {
        return [doc, score] as [Document, number];
      }

      const mergedContent = this.mergeChunkContents(doc.pageContent, neighbor.pageContent);
      return [
        new Document({
          pageContent: mergedContent,
          metadata: doc.metadata,
        }),
        score,
      ] as [Document, number];
    });

    return enriched;
  }

  private findBestNeighbor(
    target: Document,
    pool: Array<[Document, number]>,
  ): Document | null {
    const source = String(target.metadata?.source || '');
    const targetFrom = this.extractLineFrom(target.metadata);
    if (!source || targetFrom === null) {
      return null;
    }

    let best: { doc: Document; distance: number } | null = null;
    for (const [candidate] of pool) {
      if (candidate === target) {
        continue;
      }
      const candidateSource = String(candidate.metadata?.source || '');
      if (candidateSource !== source) {
        continue;
      }
      const candidateFrom = this.extractLineFrom(candidate.metadata);
      if (candidateFrom === null) {
        continue;
      }
      const distance = Math.abs(candidateFrom - targetFrom);
      if (distance === 0 || distance > 14) {
        continue;
      }
      if (!best || distance < best.distance) {
        best = { doc: candidate, distance };
      }
    }

    return best?.doc ?? null;
  }

  private extractLineFrom(metadata: Record<string, unknown> | undefined): number | null {
    const loc = metadata?.loc as
      | { lines?: { from?: number | string } }
      | undefined;
    const from = loc?.lines?.from;
    if (from === undefined || from === null) {
      return null;
    }
    const parsed = Number(from);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private mergeChunkContents(primary: string, neighbor: string): string {
    const left = (primary || '').trim();
    const right = (neighbor || '').trim();
    if (!right) {
      return left;
    }

    const tail = left.slice(-160);
    if (tail && right.startsWith(tail)) {
      return left;
    }
    return `${left}\n\nTrecho de contexto relacionado:\n${right}`;
  }

  private pickPreferred(
    left: [Document, number],
    right: [Document, number],
  ): [Document, number] {
    const leftSource = String(left[0].metadata?.source || '');
    const rightSource = String(right[0].metadata?.source || '');
    const leftVersion = this.extractVersionRank(leftSource);
    const rightVersion = this.extractVersionRank(rightSource);

    if (rightVersion > leftVersion) {
      return right;
    }
    if (leftVersion > rightVersion) {
      return left;
    }
    return right[1] < left[1] ? right : left;
  }

  private buildDedupKey(content: string): string {
    return content
      .toLowerCase()
      .replace(/página\s+\d+\s+de\s+\d+/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 350);
  }

  private getMinChunkChars(): number {
    const value = Number(this.configService.get<string>('RAG_MIN_CHUNK_CHARS') || 220);
    if (!Number.isFinite(value) || value <= 0) {
      return 220;
    }
    return Math.floor(value);
  }

  private getMinConfidenceThreshold(): number {
    const value = Number(
      this.configService.get<string>('RAG_MIN_CONFIDENCE_THRESHOLD') || 0.45,
    );
    if (!Number.isFinite(value)) {
      return 0.45;
    }
    return Math.max(0, Math.min(1, value));
  }

  private computeRetrievalConfidence(
    distances: number[],
    maxDistance: number,
  ): number {
    if (!distances.length) {
      return 0;
    }

    const bestDistance = Math.min(...distances);
    return this.distanceToConfidence(bestDistance, maxDistance);
  }

  private computeRerankScore(
    query: string,
    doc: Document,
    distance: number,
    maxDistance: number,
    proceduralIntent: boolean,
  ): number {
    const source = String(doc.metadata?.source || '');
    const sourceBoost = this.getSourceBoost(source, proceduralIntent);
    const versionRank = this.extractVersionRank(source);
    const lexical = this.computeLexicalOverlap(query, doc.pageContent);
    const confidence = this.distanceToConfidence(distance, maxDistance);

    return confidence * 0.62 + lexical * 0.25 + sourceBoost * 0.1 + versionRank * 0.00001;
  }

  private computeLexicalOverlap(query: string, content: string): number {
    const queryTokens = this.tokenize(query);
    if (!queryTokens.length) {
      return 0;
    }
    const contentTokens = new Set(this.tokenize(content));
    if (!contentTokens.size) {
      return 0;
    }

    let hitCount = 0;
    for (const token of queryTokens) {
      if (contentTokens.has(token)) {
        hitCount += 1;
      }
    }

    return hitCount / queryTokens.length;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
  }

  private distanceToConfidence(distance: number, maxDistance: number): number {
    if (!Number.isFinite(distance) || !Number.isFinite(maxDistance) || maxDistance <= 0) {
      return 0;
    }
    const normalized = 1 - distance / maxDistance;
    return Math.max(0, Math.min(1, normalized));
  }

  private extractVersionRank(source: string): number {
    const match = source.match(/S-(\d+)\.(\d+)/i);
    if (!match) {
      return 0;
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) {
      return 0;
    }
    return major * 1000 + minor;
  }

  private isProceduralIntent(query: string): boolean {
    return /(como|passo a passo|procedimento|fazer|enviar|fechamento|prestação de contas|apuração|dctfweb)/i.test(
      query,
    );
  }

  private getSourceBoost(source: string, proceduralIntent: boolean): number {
    const normalized = source.toLowerCase();
    if (proceduralIntent) {
      if (normalized.includes('/mos/')) {
        return 4;
      }
      if (normalized.includes('/manuais-web/')) {
        return 3;
      }
      if (normalized.includes('/notas-orientativas/')) {
        return 2;
      }
      if (normalized.includes('/notas-tecnicas/')) {
        return 1;
      }
      if (normalized.includes('/leiautes/')) {
        return 0;
      }
    }
    return 0;
  }

  private buildSupportPlaybook(
    query: string,
    matches: Array<[Document, number]>,
  ): string[] {
    if (!this.isProceduralIntent(query)) {
      return [];
    }

    const corpus = matches.map(([doc]) => doc.pageContent.toLowerCase()).join('\n');
    const steps: string[] = [];

    if (/s-1298|reabertura/.test(corpus)) {
      steps.push('Reabra a competência com envio do S-1298 antes de qualquer correção.');
    } else {
      steps.push('Confirme se a competência está aberta; se estiver fechada, reabra antes de ajustar eventos.');
    }

    if (/s-1005|s-1020|fpas|cnae|lotação/.test(corpus)) {
      steps.push('Revise eventos de tabela (S-1005/S-1020) que afetam cálculo e corrija primeiro.');
    }

    if (/s-1200|s-1210|s-2299|s-2399|retific/.test(corpus)) {
      steps.push('Retifique/reenvie eventos periódicos impactados (S-1200/S-1210 e correlatos) para recalcular totalizadores.');
    } else {
      steps.push('Reenvie os eventos remuneratórios e de pagamento da competência para recompor totalizadores.');
    }

    if (/s-5001|s-5011|totalizador|dctfweb/.test(corpus)) {
      steps.push('Valide os totalizadores (S-500x/S-501x) e a integração com DCTFWeb antes de fechar.');
    }

    steps.push('Envie novo S-1299 e confirme recibo sem pendências.');
    return steps;
  }
}
