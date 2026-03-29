export type RagChunk = {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  citation: string;
};

export type RagContextResponse = {
  query: string;
  collection: string;
  k: number;
  chunks: RagChunk[];
  supportPlaybook?: string[];
  retrievalConfidence?: number;
  confidenceThreshold?: number;
  confident?: boolean;
  generatedAt: string;
};
