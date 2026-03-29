# CoGuide PPS Backend

Backend em NestJS para suporte tecnico de eSocial com RAG, chat multi-turno e autenticacao JWT.

## Objetivo do projeto

Este projeto foi evoluido como case de portfolio para demonstrar:
- arquitetura backend orientada a IA aplicada em contexto real (suporte);
- pipeline RAG completo (ingestao, indexacao, retrieval, resposta no chat);
- hardening basico de API (auth, ownership, validacao);
- operacao local reproduzivel com Docker.

## Arquitetura

```text
Cliente
  -> API NestJS
      -> Auth (JWT)
      -> Chat (historico por usuario)
      -> RAG (ingestao + retrieval)
      -> LLM Gateway (Groq/Gemini + fallback)
      -> MongoDB (users/chats)
      -> ChromaDB (vetores)
      -> Ollama/OpenAI (embeddings)
```

## Fluxo completo do chat com agente

1. Usuario envia mensagem em `POST /chat/send/:id?`.
2. API gera `system message` dinamico via `getSystemMessage(query)`.
3. `RagService` busca contexto em Chroma, aplica rerank e filtro de confianca.
4. Prompt final e enviado ao LLM com historico do chat.
5. Resposta retorna em formato orientado a suporte com citacoes.
6. Mensagens sao persistidas no chat (system atualizado + user + assistant).

Observacao: o comportamento de `rag/answer` foi incorporado no proprio `chat/send`.

## Endpoints principais

- `POST /auth/signup`
- `POST /auth/login`
- `GET /auth/user`
- `POST /chat`
- `GET /chat/user/me`
- `GET /chat/:id`
- `POST /chat/send/:id?`
- `DELETE /chat/:id`
- `POST /rag/reindex`
- `POST /rag/context`

## Pipeline RAG

### Ingestao

- Fonte de documentos: pasta `raw/` (subpastas suportadas).
- Parser: PDF local (`PDFLoader`) com opcao `LlamaParse`.
- Chunking configuravel (`RAG_CHUNK_SIZE`, `RAG_CHUNK_OVERLAP`).
- Embeddings: Ollama local ou OpenAI.
- Indexacao em Chroma.

### Retrieval

- Busca por embedding em Chroma.
- Filtro por distancia maxima (`RAG_MAX_DISTANCE`).
- Filtro de chunk minimo (`RAG_MIN_CHUNK_CHARS`).
- Dedupe de chunks similares.
- Priorizacao de fonte por intencao de pergunta (MOS/manuais vs leiautes).
- Enriquecimento opcional com chunk vizinho.

## Decisoes de tuning implementadas

### 1) Rerank hibrido

Implementado no `RagService` com score combinado de:
- similaridade vetorial (distancia normalizada);
- overlap lexical pergunta x chunk;
- boost por tipo de fonte (quando a intencao e procedural);
- desempate por versao de documento.

Objetivo: reduzir chunks irrelevantes em perguntas operacionais de suporte.

### 2) Confianca minima de retrieval

- Calcula `retrievalConfidence` a partir da melhor distancia.
- Compara com `RAG_MIN_CONFIDENCE_THRESHOLD`.
- Se abaixo do limiar, contexto e retornado vazio (fail-safe).

Objetivo: evitar resposta "confiavel" sem base documental suficiente.

### 3) Citacao obrigatoria na resposta

No prompt de sistema, a resposta exige citacoes no formato `[n]` e secao:
- `Fontes consultadas`.

Objetivo: rastreabilidade para atendimento e auditoria de resposta.

### 4) Prompt orientado a suporte

Formato obrigatorio de resposta:
- Diagnostico
- Passo a passo
- Validacao
- Fontes consultadas

Objetivo: resposta acionavel para rotina de atendimento, nao texto generico.

## Seguranca aplicada

- `AuthGuard` nos endpoints sensiveis.
- Ownership check em chat (usuario so acessa proprio chat).
- `ValidationPipe` global com `whitelist` e `forbidNonWhitelisted`.
- Reindex protegido por JWT e chave administrativa opcional (`RAG_ADMIN_API_KEY`).

## Observabilidade

`AiTelemetryService` com tracing para:
- retrieval RAG;
- chat completion;
- title generation.

Integracao opcional com Langfuse via variaveis `LANGFUSE_*`.

## Como rodar

### Docker (recomendado)

1. Copie `.env.example` para `.env` e ajuste chaves.
2. Suba stack:

```bash
docker compose up --build
```

3. Para embeddings locais (Ollama):

```bash
docker compose --profile local-embeddings up --build
```

4. Reindex:

```http
POST /rag/reindex
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "resetCollection": true,
  "adminKey": "<RAG_ADMIN_API_KEY>"
}
```

### Local sem Docker

```bash
npm ci
npm run build
npm run start:dev
```

## Variaveis de ambiente importantes

Base:
- `PORT`, `CORS_ORIGIN`, `DB_URI`, `JWT_SECRET`, `JWT_EXPIRES`

LLM:
- `LLM_PROVIDER` (`groq` ou `gemini`)
- `LLM_FALLBACK_TO_GROQ`
- `GROQ_API_KEY`, `GROQ_MODEL`
- `GEMINI_API_KEY`, `GEMINI_MODEL`

RAG:
- `RAG_CHROMA_URL`, `RAG_COLLECTION`, `RAG_RAW_DIR`
- `RAG_CHUNK_SIZE`, `RAG_CHUNK_OVERLAP`
- `RAG_RETRIEVAL_CANDIDATE_MULTIPLIER`
- `RAG_MAX_DISTANCE`
- `RAG_MIN_CONFIDENCE_THRESHOLD`
- `RAG_MIN_CHUNK_CHARS`
- `RAG_EMBEDDING_PROVIDER`, `RAG_OLLAMA_EMBEDDING_MODEL`, `RAG_OPENAI_EMBEDDING_MODEL`
- `RAG_EMBED_BATCH_SIZE`

## Qualidade

Comandos usados:

```bash
npm run build
npm test -- --runInBand
```

Estado atual esperado:
- build passando;
- testes unitarios atuais passando;
- possivel log de warning do `AuthGuard` no ambiente de teste, sem quebrar a suite.

## Limitacoes conhecidas

1. Nao ha janela de historico no chat (contexto pode crescer e aumentar custo/latencia).
2. Nao ha reranker cross-encoder externo (rerank atual e heuristico/hibrido local).
3. Citacao obrigatoria esta no prompt; ainda nao existe validacao pos-resposta para forcar formato.
4. Nao existe suite de avaliacao offline (golden set) para medir precisao de forma continua.
5. `rag/context` retorna `loc.lines` e nem sempre pagina real do PDF.
6. Dependencia da qualidade do OCR/texto extraido dos PDFs de origem.

## Roadmap curto

1. Janela deslizante de historico no `chat/send`.
2. Validacao pos-geracao (garantir secao de fontes e pelo menos uma citacao `[n]`).
3. Avaliacao RAG offline com perguntas reais de suporte e metricas de qualidade.
4. Dashboard de qualidade/latencia com Langfuse.

## Licenca

Projeto privado para estudo, evolucao tecnica e portfolio.
