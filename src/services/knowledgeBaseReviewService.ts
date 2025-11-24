import * as fs from 'fs';
import * as path from 'path';
import { OpenAIService } from './openaiService';
import { ConversationService } from './conversationService';
import { CONFIG } from '../config';

export interface KnowledgeEntry {
    id: string;
    question: string;
    answer: string;
    source: string; // conversation ID or group ID
    timestamp: number;
    status: 'pending' | 'approved' | 'rejected' | 'changes_required';
    reviewedBy?: string;
    reviewedAt?: number;
    changes?: string;
}

export interface DailySummary {
    date: string;
    entries: KnowledgeEntry[];
    summaryId: string;
    messageId?: string;
}

export class KnowledgeBaseReviewService {
    private openaiService: OpenAIService;
    private conversationService: ConversationService;
    private pendingEntries: Map<string, KnowledgeEntry> = new Map();
    private dailySummaries: Map<string, DailySummary> = new Map();
    private storagePath: string;

    constructor(openaiService: OpenAIService, conversationService: ConversationService) {
        this.openaiService = openaiService;
        this.conversationService = conversationService;
        this.storagePath = path.join(__dirname, '../../data/kb_review');
        this.ensureStorageDirectory();
        this.loadPendingEntries();
    }

    private ensureStorageDirectory(): void {
        try {
            if (!fs.existsSync(this.storagePath)) {
                fs.mkdirSync(this.storagePath, { recursive: true });
                console.log(`[KBReview] Created storage directory: ${this.storagePath}`);
            }
        } catch (error) {
            console.error('[KBReview] Error creating storage directory:', error);
        }
    }

    private loadPendingEntries(): void {
        try {
            const filePath = path.join(this.storagePath, 'pending_entries.json');
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                for (const [id, entry] of Object.entries(data)) {
                    this.pendingEntries.set(id, entry as KnowledgeEntry);
                }
                console.log(`[KBReview] Loaded ${this.pendingEntries.size} pending entries`);
            }
        } catch (error) {
            console.error('[KBReview] Error loading pending entries:', error);
        }
    }

    private savePendingEntries(): void {
        try {
            const filePath = path.join(this.storagePath, 'pending_entries.json');
            const data: Record<string, KnowledgeEntry> = {};
            for (const [id, entry] of this.pendingEntries.entries()) {
                data[id] = entry;
            }
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('[KBReview] Error saving pending entries:', error);
        }
    }

    async extractKnowledgeFromConversation(conversationId: string, messages: Array<{ role: string; content: string; name?: string; timestamp?: number }>): Promise<KnowledgeEntry[]> {
        const entries: KnowledgeEntry[] = [];

        // Filter out assistant messages - we only want user conversations
        const userMessages = messages.filter(msg => msg.role === 'user');

        if (userMessages.length === 0) {
            return entries;
        }

        // Analyze the conversation in chunks to find valuable knowledge
        // Look at windows of messages to capture multi-message exchanges
        const windowSize = 5; // Look at up to 5 consecutive user messages at a time
        
        for (let i = 0; i < userMessages.length; i++) {
            // Single message analysis - could be standalone info
            const singleMsg = userMessages[i];
            const singleMsgValuable = await this.isValuableStandaloneMessage(singleMsg.content, singleMsg.name);
            
            if (singleMsgValuable.isValuable) {
                const entryId = `${conversationId}_${Date.now()}_single_${i}`;
                const entry: KnowledgeEntry = {
                    id: entryId,
                    question: singleMsgValuable.topic || 'Information shared',
                    answer: singleMsg.content.trim(),
                    source: conversationId,
                    timestamp: singleMsg.timestamp || Date.now(),
                    status: 'pending'
                };
                entries.push(entry);
                continue; // Skip to next message
            }

            // Multi-message analysis - conversation between users
            if (i < userMessages.length - 1) {
                const windowEnd = Math.min(i + windowSize, userMessages.length);
                const messageWindow = userMessages.slice(i, windowEnd);
                
                // Check if this looks like a Q&A exchange between users
                const exchange = await this.extractQAFromUserMessages(messageWindow);
                
                if (exchange) {
                    const entryId = `${conversationId}_${Date.now()}_exchange_${i}`;
                    const entry: KnowledgeEntry = {
                        id: entryId,
                        question: exchange.question,
                        answer: exchange.answer,
                        source: conversationId,
                        timestamp: messageWindow[0].timestamp || Date.now(),
                        status: 'pending'
                    };
                    entries.push(entry);
                    // Skip the messages we just processed
                    i += exchange.messagesUsed - 1;
                }
            }
        }

        return entries;
    }

    private async isValuableStandaloneMessage(content: string, userName?: string): Promise<{ isValuable: boolean; topic?: string }> {
        try {
            // Skip very short messages
            if (content.trim().length < 20) {
                return { isValuable: false };
            }

            // Skip common greetings and casual messages
            const casualPatterns = /^(hey|hi|hello|thanks|thank you|ok|okay|any|sure|yes|no|any new updates)/i;
            if (casualPatterns.test(content.trim())) {
                return { isValuable: false };
            }

            const prompt = `Analyze if this message contains valuable information that should be added to a knowledge base.

Message: "${content}"
From: ${userName || 'Unknown user'}

Consider it valuable if:
- It provides specific information about processes, procedures, or solutions
- It shares troubleshooting steps or error resolutions
- It contains instructions or how-to information
- It shares updates about system changes or new features
- It announces important information that others should know
- It's NOT just a question, greeting, acknowledgment, or casual conversation
- It's NOT asking for help or reporting a problem (those need answers first)

If valuable, extract the main topic/subject.

Respond with JSON:
{
  "isValuable": true/false,
  "topic": "Brief topic description" (only if valuable)
}`;

            const response = await this.openaiService.getCompletion([
                { role: "system", content: "You are a knowledge base curator. Identify valuable standalone information. Always return valid JSON." },
                { role: "user", content: prompt }
            ]);

            const parsed = JSON.parse(response.trim());
            return parsed;
        } catch (error) {
            console.error('[KBReview] Error evaluating standalone message:', error);
            return { isValuable: false };
        }
    }

    private async extractQAFromUserMessages(messages: Array<{ role: string; content: string; name?: string; timestamp?: number }>): Promise<{ question: string; answer: string; messagesUsed: number } | null> {
        try {
            // Build conversation text
            const conversationText = messages.map((msg, idx) => 
                `[${idx}] ${msg.name || 'User'}: ${msg.content}`
            ).join('\n');

            const prompt = `Analyze this conversation between users and extract a Q&A pair if one exists.

Conversation:
${conversationText}

Look for:
- A question or problem statement from one user
- A helpful answer or solution from another user (or same user)
- The answer should contain useful information about processes, troubleshooting, or solutions

If you find a Q&A pair, respond with JSON:
{
  "hasQA": true,
  "question": "The question or problem",
  "answer": "The answer or solution",
  "messagesUsed": number (how many messages from [0] onwards form this Q&A, minimum 2)
}

If no valuable Q&A pair exists, respond with:
{
  "hasQA": false
}`;

            const response = await this.openaiService.getCompletion([
                { role: "system", content: "You are a knowledge base curator. Extract Q&A pairs from user conversations. Always return valid JSON." },
                { role: "user", content: prompt }
            ]);

            const parsed = JSON.parse(response.trim());
            
            if (parsed.hasQA && parsed.question && parsed.answer) {
                return {
                    question: parsed.question,
                    answer: parsed.answer,
                    messagesUsed: parsed.messagesUsed || 2
                };
            }
            
            return null;
        } catch (error) {
            console.error('[KBReview] Error extracting Q&A from user messages:', error);
            return null;
        }
    }


    async addKnowledgeEntry(entry: KnowledgeEntry): Promise<void> {
        this.pendingEntries.set(entry.id, entry);
        this.savePendingEntries();
        console.log(`[KBReview] Added new knowledge entry: ${entry.id}`);
    }

    async generateDailySummary(date: Date = new Date()): Promise<DailySummary> {
        const dateStr = date.toISOString().split('T')[0];
        const summaryId = `summary_${dateStr}_${Date.now()}`;

        console.log(`[KBReview] Generating summary for ${dateStr}`);

        // Get all pending entries
        const pendingEntries = Array.from(this.pendingEntries.values())
            .filter(entry => entry.status === 'pending');

        console.log(`[KBReview] Found ${pendingEntries.length} existing pending entries`);

        // Get conversations from the date
        const conversations = this.conversationService.getConversationsForDate(date);
        console.log(`[KBReview] Found ${Object.keys(conversations).length} conversations for date ${dateStr}`);
        
        const newEntries: KnowledgeEntry[] = [];

        // Extract knowledge from conversations
        for (const [conversationId, messages] of Object.entries(conversations)) {
            console.log(`[KBReview] Processing conversation ${conversationId} with ${messages.length} messages`);
            
            try {
                const extracted = await this.extractKnowledgeFromConversation(conversationId, messages);
                console.log(`[KBReview] Extracted ${extracted.length} knowledge entries from conversation ${conversationId}`);
                
                for (const entry of extracted) {
                    // Check if entry already exists
                    const exists = Array.from(this.pendingEntries.values()).some(
                        e => e.question.toLowerCase().trim() === entry.question.toLowerCase().trim() &&
                             e.answer.toLowerCase().trim() === entry.answer.toLowerCase().trim()
                    );
                    if (!exists) {
                        await this.addKnowledgeEntry(entry);
                        newEntries.push(entry);
                        console.log(`[KBReview] Added new entry: ${entry.question.substring(0, 50)}...`);
                    } else {
                        console.log(`[KBReview] Skipping duplicate entry: ${entry.question.substring(0, 50)}...`);
                    }
                }
            } catch (error) {
                console.error(`[KBReview] Error extracting knowledge from conversation ${conversationId}:`, error);
            }
        }

        console.log(`[KBReview] Added ${newEntries.length} new knowledge entries`);

        // Combine with existing pending entries
        const allEntries = [...pendingEntries, ...newEntries];

        const summary: DailySummary = {
            date: dateStr,
            entries: allEntries,
            summaryId
        };

        this.dailySummaries.set(summaryId, summary);
        console.log(`[KBReview] Summary generated with ${allEntries.length} total entries`);
        
        return summary;
    }

    async formatSummaryMessage(summary: DailySummary): Promise<string> {
        if (summary.entries.length === 0) {
            return `📋 **Daily Knowledge Base Review - ${summary.date}**\n\nNo new knowledge entries to review today.`;
        }

        let message = `📋 **Daily Knowledge Base Review - ${summary.date}**\n\n`;
        message += `Found ${summary.entries.length} new knowledge ${summary.entries.length === 1 ? 'entry' : 'entries'} to review:\n\n`;

        summary.entries.forEach((entry, index) => {
            message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            message += `**Entry ${index + 1}** • ID: \`${entry.id}\`\n\n`;
            message += `**📝 Topic/Question:**\n${entry.question}\n\n`;
            message += `**💡 Information/Answer:**\n${entry.answer}\n\n`;
            message += `**📍 Source:** ${entry.source}\n`;
            message += `**🕐 Time:** ${new Date(entry.timestamp).toLocaleString()}\n\n`;
        });

        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        message += `**✅ How to respond:**\n`;
        message += `• Reply **"Approved"** to add all entries to the knowledge base\n`;
        message += `• Reply **"Rejected"** to discard all entries\n`;
        message += `• Reply **"Changes Required [your changes]"** to request modifications\n`;
        message += `• Reply **"Approved [Entry ID]"** or **"Rejected [Entry ID]"** for individual entries\n\n`;
        message += `Example: \`Approved ${summary.entries[0]?.id}\``;

        return message;
    }

    async processReviewResponse(messageText: string, reviewerName: string, summaryId: string): Promise<{ processed: boolean; message: string }> {
        const text = messageText.trim().toLowerCase();
        const summary = this.dailySummaries.get(summaryId);

        if (!summary) {
            // Try to find summary by date if not found by ID
            const today = new Date().toISOString().split('T')[0];
            for (const [id, s] of this.dailySummaries.entries()) {
                if (s.date === today) {
                    return await this.processReviewResponse(messageText, reviewerName, id);
                }
            }
            return { processed: false, message: 'Summary not found' };
        }

        // Check if user is authorized
        const reviewerNameLower = reviewerName.toLowerCase().replaceAll(' ', '');
        if (!CONFIG.KB_REVIEW_USERS.includes(reviewerNameLower)) {
            return { processed: false, message: 'User not authorized to review knowledge base entries' };
        }

        // Handle individual entry approval/rejection
        const individualApprovedMatch = text.match(/approved\s+([a-z0-9_]+)/i);
        const individualRejectedMatch = text.match(/rejected\s+([a-z0-9_]+)/i);

        if (individualApprovedMatch) {
            const entryId = individualApprovedMatch[1];
            return await this.processEntryReview(entryId, 'approved', reviewerName, summaryId);
        }

        if (individualRejectedMatch) {
            const entryId = individualRejectedMatch[1];
            return await this.processEntryReview(entryId, 'rejected', reviewerName, summaryId);
        }

        // Handle bulk operations
        if (text.startsWith('approved')) {
            return await this.processBulkReview(summary, 'approved', reviewerName);
        }

        if (text.startsWith('rejected')) {
            return await this.processBulkReview(summary, 'rejected', reviewerName);
        }

        if (text.startsWith('changes required')) {
            const changes = messageText.substring('changes required'.length).trim();
            return await this.processBulkReview(summary, 'changes_required', reviewerName, changes);
        }

        return { processed: false, message: 'Invalid review response format. Please reply with "Approved", "Rejected", or "Changes Required [your changes]"' };
    }

    private async processEntryReview(entryId: string, status: 'approved' | 'rejected', reviewerName: string, summaryId: string): Promise<{ processed: boolean; message: string }> {
        const entry = this.pendingEntries.get(entryId);
        if (!entry) {
            return { processed: false, message: `Entry ${entryId} not found` };
        }

        entry.status = status;
        entry.reviewedBy = reviewerName;
        entry.reviewedAt = Date.now();

        this.pendingEntries.set(entryId, entry);
        this.savePendingEntries();

        if (status === 'approved') {
            await this.addToKnowledgeBase(entry);
            return { processed: true, message: `✅ Entry ${entryId} approved and added to knowledge base.` };
        } else {
            return { processed: true, message: `❌ Entry ${entryId} rejected.` };
        }
    }

    private async processBulkReview(summary: DailySummary, status: 'approved' | 'rejected' | 'changes_required', reviewerName: string, changes?: string): Promise<{ processed: boolean; message: string }> {
        let processedCount = 0;

        for (const entry of summary.entries) {
            if (entry.status === 'pending') {
                entry.status = status;
                entry.reviewedBy = reviewerName;
                entry.reviewedAt = Date.now();
                if (status === 'changes_required' && changes) {
                    entry.changes = changes;
                }

                this.pendingEntries.set(entry.id, entry);
                this.savePendingEntries();

                if (status === 'approved') {
                    await this.addToKnowledgeBase(entry);
                    processedCount++;
                } else if (status === 'rejected') {
                    processedCount++;
                } else if (status === 'changes_required') {
                    processedCount++;
                }
            }
        }

        if (status === 'approved') {
            return { processed: true, message: `✅ ${processedCount} entries approved and added to knowledge base.` };
        } else if (status === 'rejected') {
            return { processed: true, message: `❌ ${processedCount} entries rejected.` };
        } else {
            return { processed: true, message: `📝 ${processedCount} entries marked for changes. Please review the suggested changes.` };
        }
    }

    private async addToKnowledgeBase(entry: KnowledgeEntry): Promise<void> {
        try {
            const kbPath = path.join(__dirname, '../../data/intelligate.md');
            if (!fs.existsSync(kbPath)) {
                console.error('[KBReview] Knowledge base file not found');
                return;
            }

            let kbContent = fs.readFileSync(kbPath, 'utf8');

            // Use AI to determine the best place to add this entry
            const formattedEntry = await this.formatKnowledgeEntry(entry);
            
            // Add to the end of the file with a timestamp
            const dateStr = new Date(entry.timestamp).toLocaleDateString('en-US', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            });
            kbContent += `\n\n---\n\n## New Entry - ${dateStr}\n\n`;
            kbContent += formattedEntry;
            kbContent += `\n\n*Added from conversation: ${entry.source}*\n`;

            fs.writeFileSync(kbPath, kbContent, 'utf8');
            console.log(`[KBReview] Added entry ${entry.id} to knowledge base`);
            
            // Reload the knowledge base if needed (this would require passing the AIAgentService)
            // For now, the knowledge base will be reloaded on next restart
        } catch (error) {
            console.error('[KBReview] Error adding to knowledge base:', error);
            throw error;
        }
    }

    private async formatKnowledgeEntry(entry: KnowledgeEntry): Promise<string> {
        try {
            const prompt = `Format the following Q&A pair into a clear, well-structured knowledge base entry in Markdown format.

Question: "${entry.question}"
Answer: "${entry.answer}"

Format it as:
- A clear heading or subheading
- The question formatted as a bold statement or subheading
- The answer formatted as clear, readable text with proper formatting (bullets, numbered lists, etc. if applicable)

Return ONLY the formatted Markdown text, nothing else.`;

            const formatted = await this.openaiService.getCompletion([
                { role: "system", content: "You are a technical writer. Format Q&A pairs into clear, well-structured knowledge base entries." },
                { role: "user", content: prompt }
            ]);

            return formatted;
        } catch (error) {
            console.error('[KBReview] Error formatting entry:', error);
            // Fallback formatting
            return `### ${entry.question}\n\n${entry.answer}\n`;
        }
    }

    getPendingEntries(): KnowledgeEntry[] {
        return Array.from(this.pendingEntries.values()).filter(e => e.status === 'pending');
    }

    getSummary(summaryId: string): DailySummary | undefined {
        return this.dailySummaries.get(summaryId);
    }
}

