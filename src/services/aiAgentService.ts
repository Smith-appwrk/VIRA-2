import { RAGService } from './ragService';
import { ContextService } from './contextService';
import { OpenAIService } from './openaiService';
import { CONFIG } from '../config';

export class AIAgentService {
    private openaiService: OpenAIService;
    private ragService: RAGService;
    private contextService: ContextService;
    private initialized: boolean = false;

    constructor(openaiService: OpenAIService) {
        this.openaiService = openaiService;
        this.ragService = new RAGService(openaiService);
        this.contextService = new ContextService(openaiService);
    }

    async initialize(knowledgeBaseContent: string): Promise<void> {
        if (this.initialized) return;

        await this.ragService.initialize(knowledgeBaseContent);
        this.initialized = true;

        console.log('[AIAgentService] Initialized with optimized RAG and context management');
    }

    async generateResponse(conversationId: string, conversationHistory: Array<{ role: string; content: string }>, userQuery: string, detectedLanguage: string): Promise<string> {
        try {
            const relevantKnowledge = await this.ragService.findRelevantChunks(userQuery, 3);
            const knowledgeContext = relevantKnowledge.join('\n\n');

            const optimizedContext = await this.contextService.getContextWithinTokenLimit(
                conversationId,
                conversationHistory,
                userQuery,
                1500
            );

            const systemPrompt = this.createOptimizedSystemPrompt(detectedLanguage, knowledgeContext);

            const messages = [
                { role: "system", content: systemPrompt },
                ...optimizedContext,
                { role: "user", content: userQuery }
            ];

            this.logTokenSavings(knowledgeContext, optimizedContext, userQuery);

            const response = await this.openaiService.getCompletion(messages);

            return response;

        } catch (error) {
            console.error('[AIAgentService] Error generating response:', error);
            throw error;
        }
    }

    createOptimizedSystemPrompt(detectedLanguage: string, relevantKnowledge: string): string {
        return `You are an IntelliGate support assistant. Respond in ${detectedLanguage} when appropriate.

Response Guidelines:
1. Adapt response style based on query complexity
2. Use 1-3 sentences for simple answers, 1-2 paragraphs for complex ones
3. Professional tone for technical queries, conversational for general questions
4. Always paraphrase knowledge base content using original phrasing
5. Current date: ${new Date().toLocaleDateString()}

IMPORTANT: 
- If no relevant information exists, respond: NO_ANSWER
- If user needs support team, respond: NEED_SUPPORT

Relevant Knowledge Base:
${relevantKnowledge}

Note: Respond naturally based on conversation flow.`;
    }

    logTokenSavings(knowledgeContext: string, optimizedContext: Array<{ role: string; content: string }>, userQuery: string): void {
        const knowledgeTokens = this.contextService.estimateTokenCount(knowledgeContext);
        const contextTokens = optimizedContext.reduce((sum, msg) =>
            sum + this.contextService.estimateTokenCount(msg.content), 0);
        const queryTokens = this.contextService.estimateTokenCount(userQuery);

        const totalTokens = knowledgeTokens + contextTokens + queryTokens;

        console.log(`[AIAgentService] Token usage optimization:
        - Knowledge chunks: ~${knowledgeTokens} tokens (vs full KB which could be 5000+)
        - Context: ~${contextTokens} tokens (${optimizedContext.length} messages)
        - Query: ~${queryTokens} tokens
        - Total: ~${totalTokens} tokens
        - Estimated savings: ~${Math.max(0, 5000 - totalTokens)} tokens per request`);
    }
}

