import { Test, TestingModule } from '@nestjs/testing';
import { GroqCloudService } from './groq-cloud.service';
import { ConfigService } from '@nestjs/config';
import { RagService } from '../rag/rag.service';
import { AiTelemetryService } from '../rag/ai-telemetry.service';

describe('GroqCloudService', () => {
  let service: GroqCloudService;

  beforeEach(async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroqCloudService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'GROQ_API_KEY') {
                return 'test-key';
              }
              if (key === 'LLM_PROVIDER') {
                return 'groq';
              }
              if (key === 'GROQ_MODEL') {
                return 'llama3-8b-8192';
              }
              return undefined;
            }),
          },
        },
        {
          provide: RagService,
          useValue: {
            getContextPayload: jest.fn().mockResolvedValue({
              query: 'test',
              collection: 'rag',
              k: 3,
              chunks: [],
              generatedAt: new Date().toISOString(),
            }),
            formatContextForPrompt: jest.fn().mockReturnValue(''),
          },
        },
        {
          provide: AiTelemetryService,
          useValue: {
            trace: jest.fn().mockImplementation(async (_n, _p, fn) => fn()),
          },
        },
      ],
    }).compile();

    service = module.get<GroqCloudService>(GroqCloudService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
