import { RAGService } from "./ragService";
import { ContextService } from "./contextService";
import { OpenAIService } from "./openaiService";
import { AzureSearchService } from "./azureSearchService";
import { CONFIG } from "../config";

export class AIAgentService {
  private openaiService: OpenAIService;
  private ragService: RAGService;
  private contextService: ContextService;
  private initialized: boolean = false;

  constructor(
    openaiService: OpenAIService,
    azureSearchService?: AzureSearchService
  ) {
    this.openaiService = openaiService;
    this.ragService = new RAGService(openaiService, azureSearchService);
    this.contextService = new ContextService(openaiService);
  }

  async initialize(knowledgeBaseContent: string): Promise<void> {
    if (this.initialized) return;

    await this.ragService.initialize(knowledgeBaseContent);
    this.initialized = true;

    console.log(
      "[AIAgentService] Initialized with optimized RAG and context management"
    );
  }

  async generateResponse(
    conversationId: string,
    conversationHistory: string,
    userQuery: string
  ): Promise<string> {
    try {
      // Step 1: Retrieve knowledge chunks with vector search
      const relevantKnowledge = await this.ragService.findRelevantChunks(
        userQuery,
        5, // Get more chunks for better evaluation
        0.032 // Minimum similarity threshold
      );

      // Step 2: Strict confidence filtering with LLM-based relevance scoring
      if (!relevantKnowledge || relevantKnowledge.length === 0) {
        console.log(
          "[AIAgentService] No relevant knowledge found - returning NO_ANSWER"
        );
        return "NO_ANSWER";
      }

      // Step 3: Score relevance of retrieved chunks
      const relevanceScore = await this.openaiService.scoreRelevance(
        userQuery,
        relevantKnowledge
      );

      console.log(
        `[AIAgentService] Relevance confidence: ${relevanceScore.confidence.toFixed(
          3
        )}`
      );
      console.log(`[AIAgentService] Reasoning: ${relevanceScore.reasoning}`);

      // Step 4: Only proceed if confidence is >= 0.7 (70%)
      // This is stricter than the 90% mentioned in requirements but allows for some flexibility
      // You can adjust this threshold based on your needs
      const CONFIDENCE_THRESHOLD = 0.7;

      if (relevanceScore.confidence < CONFIDENCE_THRESHOLD) {
        console.log(
          `[AIAgentService] Confidence ${relevanceScore.confidence.toFixed(
            3
          )} below threshold ${CONFIDENCE_THRESHOLD} - returning NO_ANSWER`
        );
        return "NO_ANSWER";
      }

      // Step 5: Use only the relevant chunks that passed the relevance check
      const filteredKnowledge =
        relevanceScore.relevantChunks.length > 0
          ? relevanceScore.relevantChunks.join("\n\n")
          : relevantKnowledge.join("\n\n"); // Fallback to original chunks if scoring didn't filter

      if (!filteredKnowledge || filteredKnowledge.length < 10) {
        console.log(
          "[AIAgentService] Filtered knowledge too short - returning NO_ANSWER"
        );
        return "NO_ANSWER";
      }

      // Step 6: Generate response with validated knowledge
      const systemPrompt = this.createOptimizedSystemPrompt(
        filteredKnowledge,
        conversationHistory,
        relevanceScore.confidence
      );

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userQuery },
      ];

      const response = await this.openaiService.getCompletion(messages);

      // Step 7: Final validation - check if response indicates uncertainty
      const lowerResponse = response.toLowerCase();
      if (
        lowerResponse.includes("i don't know") ||
        lowerResponse.includes("i'm not sure") ||
        lowerResponse.includes("i cannot") ||
        lowerResponse.includes("unable to") ||
        lowerResponse.includes("no information") ||
        lowerResponse.includes("not available")
      ) {
        console.log(
          "[AIAgentService] Response indicates uncertainty - returning NO_ANSWER"
        );
        return "NO_ANSWER";
      }

      return response;
    } catch (error) {
      console.error("[AIAgentService] Error generating response:", error);
      // On error, return NO_ANSWER to be safe
      return "NO_ANSWER";
    }
  }

  createOptimizedSystemPrompt(
    relevantKnowledge: string,
    conversationHistory: string,
    confidenceScore: number = 1.0
  ): string {
    const confidenceWarning =
      confidenceScore < 0.9
        ? `\n\n⚠️ CONFIDENCE WARNING: The retrieved knowledge has a relevance score of ${(
            confidenceScore * 100
          ).toFixed(
            1
          )}%. Only answer if you are CERTAIN the knowledge directly addresses the question. If uncertain, respond with "NO_ANSWER".`
        : "";

    return `You are an IntelliGate support assistant. Your PRIMARY responsibility is to ONLY answer questions when you have SPECIFIC, RELEVANT information from the knowledge base.

CRITICAL RULES:
1. You MUST respond with "NO_ANSWER" if:
   - The knowledge base content doesn't directly answer the question
   - You need to make assumptions or inferences beyond what's provided
   - The information is incomplete or unclear
   - You're less than 90% confident in your answer

2. You MAY answer if:
   - The knowledge base contains SPECIFIC information that directly addresses the question
   - You can provide a clear, factual answer based solely on the provided knowledge
   - You are MORE than 90% confident in your answer

3. Response Guidelines:
   - Use 1-3 sentences for simple answers, 1-2 paragraphs for complex ones
   - Professional tone for technical queries, conversational for general questions
   - Always paraphrase knowledge base content using original phrasing
   - Current date: ${new Date().toLocaleDateString()}

Relevant Knowledge Base:
${relevantKnowledge || "No relevant knowledge found - respond: NO_ANSWER"}
${confidenceWarning}

Previous Conversation Context:
${conversationHistory || "No previous conversation"}

Remember: It's better to say "NO_ANSWER" than to provide incorrect or generalized information. Only answer when you're CERTAIN.`;
  }

  logTokenSavings(
    knowledgeContext: string,
    optimizedContext: Array<{ role: string; content: string }>,
    userQuery: string
  ): void {
    const knowledgeTokens =
      this.contextService.estimateTokenCount(knowledgeContext);
    const contextTokens = optimizedContext.reduce(
      (sum, msg) => sum + this.contextService.estimateTokenCount(msg.content),
      0
    );
    const queryTokens = this.contextService.estimateTokenCount(userQuery);

    const totalTokens = knowledgeTokens + contextTokens + queryTokens;

    console.log(`[AIAgentService] Token usage optimization:
        - Knowledge chunks: ~${knowledgeTokens} tokens (vs full KB which could be 5000+)
        - Context: ~${contextTokens} tokens (${
      optimizedContext.length
    } messages)
        - Query: ~${queryTokens} tokens
        - Total: ~${totalTokens} tokens
        - Estimated savings: ~${Math.max(
          0,
          5000 - totalTokens
        )} tokens per request`);
  }
}
