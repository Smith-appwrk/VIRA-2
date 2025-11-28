import { OpenAIService } from "./openaiService";
import { AzureSearchService } from "./azureSearchService";
import { CONFIG } from "../config";

export class RAGService {
  private openaiService: OpenAIService;
  private azureSearchService?: AzureSearchService;
  private knowledgeBase: string = "";
  private knowledgeChunks: string[] = [];
  private initialized: boolean = false;
  private useVectorSearch: boolean = false;

  constructor(
    openaiService: OpenAIService,
    azureSearchService?: AzureSearchService
  ) {
    this.openaiService = openaiService;
    this.azureSearchService = azureSearchService;
    this.useVectorSearch =
      !!CONFIG.AZURE_SEARCH_ENDPOINT && !!azureSearchService;
  }

  async initialize(knowledgeBaseContent: string): Promise<void> {
    if (this.initialized) return;

    this.knowledgeBase = knowledgeBaseContent;
    this.knowledgeChunks = this.chunkText(knowledgeBaseContent);

    // Initialize Azure AI Search if available
    if (this.useVectorSearch && this.azureSearchService) {
      try {
        await this.azureSearchService.initialize();
        console.log(
          `[RAGService] Initialized with Azure AI Search (vector search enabled)`
        );
      } catch (error) {
        console.warn(
          "[RAGService] Azure AI Search initialization failed, falling back to keyword search:",
          error
        );
        this.useVectorSearch = false;
      }
    }

    if (!this.useVectorSearch) {
      console.log(
        `[RAGService] Initialized with ${this.knowledgeChunks.length} knowledge chunks (keyword search)`
      );
    }

    this.initialized = true;
  }

  chunkText(text: string, maxChunkSize: number = 500): string[] {
    const sections = text.split(/#{1,3}\s/);
    const chunks: string[] = [];

    for (const section of sections) {
      if (section.trim().length === 0) continue;

      if (section.length <= maxChunkSize) {
        chunks.push(section.trim());
      } else {
        const paragraphs = section.split("\n\n");
        let currentChunk = "";

        for (const paragraph of paragraphs) {
          if ((currentChunk + paragraph).length <= maxChunkSize) {
            currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
          } else {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = paragraph;
          }
        }

        if (currentChunk) chunks.push(currentChunk.trim());
      }
    }

    return chunks;
  }

  async findRelevantChunks(
    query: string,
    maxChunks: number = 3,
    minScore: number = 0.032
  ): Promise<string[]> {
    try {
      // Use hybrid search with score threshold
      // Only returns results with similarity score >= minScore
      const results = await this.azureSearchService.hybridSearch(
        query,
        maxChunks,
        minScore // Minimum similarity threshold (0.7 = 70% similarity)
      );

      // Format results as chunks
      const chunks = results.map((result) => {
        // Prefer structured answer field if available, otherwise use content
        return result.answer || result.content;
      });

      if (chunks.length > 0) {
        console.log(
          `[RAGService] Vector search found ${chunks.length} relevant chunks (score >= ${minScore})`
        );
        // Log scores for debugging
        results.forEach((result, idx) => {
          console.log(
            `[RAGService] Chunk ${idx + 1} score: ${result.score.toFixed(3)}`
          );
        });
        return chunks;
      } else {
        console.log(
          `[RAGService] No relevant chunks found (all results below ${minScore} threshold)`
        );
        return [];
      }
    } catch (error) {
      console.error(
        "[RAGService] Vector search failed, falling back to keyword search:",
        error
      );
      // Fall through to keyword search
      return [];
    }
  }

  async getContextForQuery(
    query: string,
    maxChunks: number = 3
  ): Promise<string[]> {
    return await this.findRelevantChunks(query, maxChunks);
  }
}
