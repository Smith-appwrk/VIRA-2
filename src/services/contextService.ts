import { OpenAIService } from './openaiService';
import { CONFIG } from '../config';

export class ContextService {
    private openaiService: OpenAIService;
    private conversationSummaries: Map<string, string> = new Map();
    private MAX_RECENT_MESSAGES = 6;
    private SUMMARY_THRESHOLD = 10;

    constructor(openaiService: OpenAIService) {
        this.openaiService = openaiService;
    }

    async getOptimizedContext(conversationId: string, conversationHistory: Array<{ role: string; content: string }>, userQuery: string): Promise<Array<{ role: string; content: string }>> {
        try {
            if (!conversationHistory || conversationHistory.length === 0) {
                return [];
            }

            if (conversationHistory.length <= this.MAX_RECENT_MESSAGES) {
                return conversationHistory.map(msg => ({
                    role: msg.role === 'user' ? 'user' : 'assistant',
                    content: msg.content || "content not found"
                }));
            }

            const recentMessages = conversationHistory.slice(-this.MAX_RECENT_MESSAGES);
            const oldMessages = conversationHistory.slice(0, -this.MAX_RECENT_MESSAGES);

            let contextMessages: Array<{ role: string; content: string }> = [];

            if (oldMessages.length > 0) {
                const summary = await this.getSummary(conversationId, oldMessages);
                if (summary) {
                    contextMessages.push({
                        role: 'system',
                        content: `Previous conversation summary: ${summary}`
                    });
                }
            }

            const recentFormatted = recentMessages.map(msg => ({
                role: msg.role === 'user' ? 'user' : 'assistant',
                content: msg.content || "content not found"
            }));

            contextMessages.push(...recentFormatted);

            console.log(`[ContextService] Optimized context: ${oldMessages.length} old messages summarized, ${recentMessages.length} recent messages kept`);
            return contextMessages;

        } catch (error) {
            console.error('[ContextService] Error optimizing context:', error);
            return conversationHistory.slice(-this.MAX_RECENT_MESSAGES).map(msg => ({
                role: msg.role === 'user' ? 'user' : 'assistant',
                content: msg.content || "content not found"
            }));
        }
    }

    async getSummary(conversationId: string, messages: Array<{ role: string; content: string }>): Promise<string | null> {
        try {
            const summaryKey = `${conversationId}_${messages.length}`;
            if (this.conversationSummaries.has(summaryKey)) {
                return this.conversationSummaries.get(summaryKey) || null;
            }

            const messagesToSummarize = messages.map(msg =>
                `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
            ).join('\n');

            const summaryPrompt = `
Summarize the following conversation history in 2-3 sentences, focusing on:
1. Key questions asked by the user
2. Main topics discussed
3. Any important context or ongoing issues

Conversation:
${messagesToSummarize}

Keep the summary concise and focused on information that might be relevant for future responses.`;

            // Use OpenAI service's getCompletion method
            const summaryMessages = [
                {
                    role: "system",
                    content: "You are a conversation summarizer. Create concise, informative summaries."
                },
                { role: "user", content: summaryPrompt }
            ];
            
            const summaryText = await this.openaiService.getCompletion(summaryMessages);
            const summary = summaryText;

            if (summary) {
                this.conversationSummaries.set(summaryKey, summary);
                this.cleanupOldSummaries();
            }

            return summary;

        } catch (error) {
            console.error('[ContextService] Error creating summary:', error);
            return null;
        }
    }

    cleanupOldSummaries(): void {
        if (this.conversationSummaries.size > 100) {
            const entries = Array.from(this.conversationSummaries.entries());
            const recentEntries = entries.slice(-50);
            this.conversationSummaries.clear();
            recentEntries.forEach(([key, value]) => {
                this.conversationSummaries.set(key, value);
            });
        }
    }

    estimateTokenCount(text: string): number {
        return Math.ceil(text.length / 4);
    }

    async getContextWithinTokenLimit(conversationId: string, conversationHistory: Array<{ role: string; content: string }>, userQuery: string, maxTokens: number = 2000): Promise<Array<{ role: string; content: string }>> {
        const optimizedContext = await this.getOptimizedContext(conversationId, conversationHistory, userQuery);

        let totalTokens = 0;
        const finalContext: Array<{ role: string; content: string }> = [];

        for (const message of optimizedContext.reverse()) {
            const messageTokens = this.estimateTokenCount(message.content);
            if (totalTokens + messageTokens > maxTokens && finalContext.length > 0) {
                break;
            }
            finalContext.unshift(message);
            totalTokens += messageTokens;
        }

        console.log(`[ContextService] Final context: ${finalContext.length} messages, ~${totalTokens} tokens`);
        return finalContext;
    }
}

