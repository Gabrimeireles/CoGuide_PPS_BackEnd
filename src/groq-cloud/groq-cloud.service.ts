import { Injectable } from '@nestjs/common';
import GroqClient from 'groq-sdk';
import { ConfigService } from '@nestjs/config';
import { RagService } from '../rag/rag.service';
import { AiTelemetryService } from '../rag/ai-telemetry.service';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

@Injectable()
export class GroqCloudService {
  private groqClient: GroqClient | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly ragService: RagService,
    private readonly telemetryService: AiTelemetryService,
  ) {}

  async getChatResponse(
    prompt: string,
    chatHistory: ChatMessage[],
  ): Promise<string> {
    const messages: ChatMessage[] = [...chatHistory, { role: 'user', content: prompt }];
    const primaryProvider = this.getLlmProvider();

    try {
      return await this.runChatCompletion(primaryProvider, prompt, chatHistory.length, messages);
    } catch (error: unknown) {
      if (primaryProvider === 'gemini' && this.isFallbackToGroqEnabled()) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.warn(`[LLM fallback] Gemini failed, switching to Groq. Reason: ${message}`);
        return this.runChatCompletion('groq', prompt, chatHistory.length, messages);
      }

      throw error;
    }
  }

  async generateTitle(prompt: string): Promise<string> {
    const messages: GroqClient.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'user',
        content: [
          'Task: generate a title for a support chat.',
          'Output rules:',
          '- Return only ONE line with the final title.',
          '- Do NOT return options, lists, labels, or explanations.',
          '- Do NOT use quotes, markdown, or emojis.',
          '- Max 12 words.',
          '- Keep the same language as the user prompt.',
          '',
          `User prompt: "${prompt}"`,
          '',
          'Final title:',
        ].join('\n'),
        name: 'title-generator',
      },
    ];

    try {
      const primaryProvider = this.getLlmProvider();

      try {
        const generated = await this.runTitleGeneration(primaryProvider, prompt, messages);
        return this.normalizeGeneratedTitle(generated, prompt);
      } catch (error: unknown) {
        if (primaryProvider === 'gemini' && this.isFallbackToGroqEnabled()) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.warn(`[LLM fallback] Gemini title generation failed, switching to Groq. Reason: ${message}`);
          const generated = await this.runTitleGeneration('groq', prompt, messages);
          return this.normalizeGeneratedTitle(generated, prompt);
        }
        throw error;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error occurred while generating title:', message);
      return 'Untitled Chat';
    }
  }

  async getSystemMessage(query = 'eSocial'): Promise<string> {
    try {
      const contextPayload = await this.ragService.getContextPayload(query, 3);
      const contextText = this.ragService.formatContextForPrompt(contextPayload);
      const supportPlaybookText = (contextPayload.supportPlaybook || [])
        .map((step, index) => `${index + 1}. ${step}`)
        .join('\n');
      const confidenceInfo =
        typeof contextPayload.retrievalConfidence === 'number'
          ? `Confianca da recuperacao: ${contextPayload.retrievalConfidence.toFixed(2)} (limiar ${(
              contextPayload.confidenceThreshold ?? 0
            ).toFixed(2)}).`
          : 'Confianca da recuperacao: nao disponivel.';

      const systemPrompt = [
        'Voce e um assistente tecnico de suporte sobre eSocial para clientes de software de RH.',
        'Escreva SEMPRE em portugues brasileiro e em texto puro (sem markdown).',
        '',
        'Hierarquia de decisao:',
        '1) Priorize exatamente o contexto recuperado.',
        '2) Nao invente norma, prazo, codigo de evento ou procedimento.',
        '3) Se houver insuficiencia de base, responda exatamente:',
        '"Nao encontrei base documental suficiente para responder com seguranca."',
        'Em seguida, solicite o evento e o periodo exatos.',
        '',
        'Regras obrigatorias:',
        '- Toda orientacao deve incluir citacoes no formato [n].',
        '- Use apenas os identificadores [n] presentes no contexto.',
        '- Se houver conflito entre trechos, sinalize o conflito e priorize o trecho mais especifico e mais recente.',
        '- Nao omita pre-condicoes, excecoes e validacoes finais.',
        '',
        'Formato obrigatorio da resposta:',
        'Diagnostico:',
        '<resumo objetivo do problema e causa provavel>',
        '',
        'Passo a passo:',
        '1. <acao concreta>',
        '2. <acao concreta>',
        '',
        'Validacao:',
        '- <checagem objetiva de sucesso>',
        '',
        'Fontes consultadas:',
        '- [n] <resumo curto da fonte usada>',
      ].join('\n');

      const fallbackGuard = contextPayload.confident
        ? ''
        : '\nATENCAO: recuperacao com baixa confianca. Responda com cautela e use a mensagem de insuficiencia documental quando necessario.\n';

      const supportPlaybookSection = supportPlaybookText
        ? `\nPlaybook sugerido para atendimento:\n${supportPlaybookText}\n`
        : '';

      return (
        `${systemPrompt}\n\n` +
        `${confidenceInfo}${fallbackGuard}${supportPlaybookSection}\n` +
        `Contexto recuperado:\n${contextText}`
      );
    } catch (error) {
      console.error('Error reading markdown file:', error);
      throw new Error('Failed to load system message');
    }
  }

  private getLlmProvider(): 'groq' | 'gemini' {
    const provider = (this.configService.get<string>('LLM_PROVIDER') || 'groq').toLowerCase();
    return provider === 'gemini' ? 'gemini' : 'groq';
  }

  private getModelForProvider(provider: 'groq' | 'gemini'): string {
    if (provider === 'gemini') {
      return this.configService.get<string>('GEMINI_MODEL') || 'gemini-2.0-flash';
    }

    return this.configService.get<string>('GROQ_MODEL') || 'llama3-8b-8192';
  }

  private isFallbackToGroqEnabled(): boolean {
    const value = (this.configService.get<string>('LLM_FALLBACK_TO_GROQ') || 'true').toLowerCase();
    return value !== 'false' && value !== '0' && value !== 'no';
  }

  private async runChatCompletion(
    provider: 'groq' | 'gemini',
    prompt: string,
    historySize: number,
    messages: ChatMessage[],
  ): Promise<string> {
    const model = this.getModelForProvider(provider);

    return this.telemetryService.trace(
      `${provider}_chat_completion`,
      {
        input: { prompt, historySize },
        metadata: { model, provider },
      },
      async () => {
        if (provider === 'gemini') {
          return this.getGeminiChatCompletion(messages, 1024, 0.5);
        }

        const completion = await this.getGroqClient().chat.completions.create({
          messages,
          model,
          max_tokens: 1024,
          temperature: 0.5,
        });

        if (completion.choices.length > 0) {
          return completion.choices[0].message?.content || '';
        }

        return '';
      },
    );
  }

  private async runTitleGeneration(
    provider: 'groq' | 'gemini',
    prompt: string,
    messages: GroqClient.Chat.Completions.ChatCompletionMessageParam[],
  ): Promise<string> {
    const model = this.getModelForProvider(provider);

    return this.telemetryService.trace(
      `${provider}_title_generation`,
      {
        input: { prompt },
        metadata: { model, provider },
      },
      async () => {
        if (provider === 'gemini') {
          const title = await this.getGeminiChatCompletion(
            [{ role: 'user', content: messages[0].content as string }],
            20,
            0.5,
          );
          return title || 'Untitled Chat';
        }

        const completion = await this.getGroqClient().chat.completions.create({
          messages,
          model,
          max_tokens: 20,
          temperature: 0.5,
        });

        return completion.choices.length > 0
          ? completion.choices[0].message.content?.trim() || 'Untitled Chat'
          : 'Untitled Chat';
      },
    );
  }

  private normalizeGeneratedTitle(rawTitle: string, prompt: string): string {
    const cleaned = (rawTitle || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\*\*/g, '')
      .replace(/[`"]/g, '')
      .trim();

    const lines = cleaned
      .split(/\r?\n+/)
      .map((line) =>
        line
          .replace(/^[-*]\s+/, '')
          .replace(/^\d+[.)]\s+/, '')
          .replace(/^op(?:cao|c[aã]o)\s*\d+\s*:\s*/i, '')
          .trim(),
      )
      .filter(Boolean);

    const selected =
      lines.find(
        (line) =>
          !/^(aqui estao|here are|opcoes|options)/i.test(line),
      ) || '';

    const safeTitle = selected || this.fallbackTitleFromPrompt(prompt);
    return safeTitle.slice(0, 80).trim() || 'Untitled Chat';
  }

  private fallbackTitleFromPrompt(prompt: string): string {
    const normalized = (prompt || '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return 'Untitled Chat';
    }

    return normalized.split(' ').slice(0, 10).join(' ');
  }

  private async getGeminiChatCompletion(
    messages: ChatMessage[],
    maxOutputTokens: number,
    temperature: number,
  ): Promise<string> {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }

    const model = this.getModelForProvider('gemini');
    const systemText = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
      .trim();

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens,
      },
    };

    if (systemText) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('')
        .trim() || '';

    return text;
  }

  private getGroqClient(): GroqClient {
    if (this.groqClient) {
      return this.groqClient;
    }

    const apiKey = this.configService.get<string>('GROQ_API_KEY');
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not configured');
    }

    this.groqClient = new GroqClient({ apiKey });
    return this.groqClient;
  }
}

