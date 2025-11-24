import { OpenAIService } from './openaiService';

export class RAGService {
    private openaiService: OpenAIService;
    private knowledgeBase: string = '';
    private knowledgeChunks: string[] = [];
    private initialized: boolean = false;

    constructor(openaiService: OpenAIService) {
        this.openaiService = openaiService;
    }

    async initialize(knowledgeBaseContent: string): Promise<void> {
        if (this.initialized) return;

        this.knowledgeBase = knowledgeBaseContent;
        this.knowledgeChunks = this.chunkText(knowledgeBaseContent);

        console.log(`[RAGService] Initialized with ${this.knowledgeChunks.length} knowledge chunks`);
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
                const paragraphs = section.split('\n\n');
                let currentChunk = '';

                for (const paragraph of paragraphs) {
                    if ((currentChunk + paragraph).length <= maxChunkSize) {
                        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
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

    async findRelevantChunks(query: string, maxChunks: number = 3): Promise<string[]> {
        try {
            const relevantChunks: Array<{ chunk: string; score: number }> = [];
            const queryWords = query.toLowerCase().split(/\s+/);

            for (const chunk of this.knowledgeChunks) {
                let score = 0;
                const chunkLower = chunk.toLowerCase();

                for (const word of queryWords) {
                    if (word.length < 3) continue;
                    const regex = new RegExp(`\\b${word}`, 'gi');
                    const matches = (chunkLower.match(regex) || []).length;
                    score += matches * word.length;
                }

                if (chunkLower.includes(query.toLowerCase())) {
                    score += query.length * 2;
                }

                if (score > 0) {
                    relevantChunks.push({ chunk, score });
                }
            }

            const topChunks = relevantChunks
                .sort((a, b) => b.score - a.score)
                .slice(0, maxChunks)
                .map(item => item.chunk);

            console.log(`[RAGService] Found ${topChunks.length} relevant chunks for query: "${query}"`);
            return topChunks;

        } catch (error) {
            console.error('[RAGService] Error finding relevant chunks:', error);
            return this.knowledgeChunks.slice(0, maxChunks);
        }
    }

    async getContextForQuery(query: string, maxChunks: number = 3): Promise<string[]> {
        return await this.findRelevantChunks(query, maxChunks);
    }
}

