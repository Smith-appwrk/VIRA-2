import * as fs from 'fs';
import * as path from 'path';

interface Message {
    role: string;
    name?: string;
    content: string;
    timestamp: number;
    groupId?: string;
}

export class ConversationService {
    private conversationHistory: Map<string, Message[]> = new Map();
    private MESSAGE_RETENTION_COUNT: number;
    private CONVERSATION_RETENTION_MS = 24 * 60 * 60 * 1000;
    private conversationsDir: string;

    constructor(messageRetentionCount: number) {
        this.MESSAGE_RETENTION_COUNT = messageRetentionCount;
        this.conversationsDir = path.join(__dirname, '../../data/conversations');
        this.ensureConversationsDirectory();
        this.loadConversationsFromDisk();
    }

    ensureConversationsDirectory(): void {
        try {
            if (!fs.existsSync(this.conversationsDir)) {
                fs.mkdirSync(this.conversationsDir, { recursive: true });
                console.log(`Created conversations directory: ${this.conversationsDir}`);
            }
        } catch (error) {
            console.error('Error creating conversations directory:', error);
        }
    }

    getConversationFilePath(date: Date): string {
        const dateStr = date.toISOString().split('T')[0];
        return path.join(this.conversationsDir, `conversations-${dateStr}.json`);
    }

    loadConversationsFromDisk(): void {
        try {
            if (!fs.existsSync(this.conversationsDir)) {
                return;
            }

            const files = fs.readdirSync(this.conversationsDir);
            const conversationFiles = files.filter(file => file.startsWith('conversations-') && file.endsWith('.json'));

            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);

            for (const file of conversationFiles) {
                const filePath = path.join(this.conversationsDir, file);
                const conversations = JSON.parse(fs.readFileSync(filePath, 'utf8'));

                for (const [conversationId, messages] of Object.entries(conversations)) {
                    const msgArray = messages as Message[];
                    if (msgArray.length > 0) {
                        const lastMessage = msgArray[msgArray.length - 1];
                        const messageDate = new Date(lastMessage.timestamp);

                        if (messageDate >= yesterday) {
                            this.conversationHistory.set(conversationId, msgArray);
                        }
                    }
                }
            }

            console.log(`Loaded ${this.conversationHistory.size} conversations from disk`);
        } catch (error) {
            console.error('Error loading conversations from disk:', error);
        }
    }

    getConversationsForDate(date: Date): Record<string, Message[]> {
        try {
            const filePath = this.getConversationFilePath(date);

            if (!fs.existsSync(filePath)) {
                return {};
            }

            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            console.error('Error reading conversations for date:', error);
            return {};
        }
    }

    addMessageToHistory(conversationId: string, message: Message, groupId: string | null = null): void {
        if (!this.conversationHistory.has(conversationId)) {
            this.conversationHistory.set(conversationId, []);
        }

        const history = this.conversationHistory.get(conversationId) || [];
        history.push(message);

        if (history.length > this.MESSAGE_RETENTION_COUNT) {
            this.conversationHistory.set(
                conversationId,
                history.slice(history.length - this.MESSAGE_RETENTION_COUNT)
            );
        }
    }

    getConversationHistory(conversationId: string): Message[] {
        return this.conversationHistory.get(conversationId) || [];
    }

    cleanupOldConversations(): void {
        const currentTime = Date.now();
        let deletedCount = 0;

        for (const [conversationId, history] of this.conversationHistory.entries()) {
            if (history.length === 0) {
                this.conversationHistory.delete(conversationId);
                deletedCount++;
                continue;
            }

            const lastMessageTime = Math.max(...history.map(msg => msg.timestamp || 0));
            if (currentTime - lastMessageTime > this.CONVERSATION_RETENTION_MS) {
                this.conversationHistory.delete(conversationId);
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            console.log({
                type: 'ConversationCleanup',
                deletedConversations: deletedCount,
                timestamp: new Date().toISOString()
            });
        }
    }
}

