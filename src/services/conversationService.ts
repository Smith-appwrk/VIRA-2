import * as fs from "fs";
import * as path from "path";
import { DatabaseService, ConversationMessage } from "./databaseService";

interface Message {
  role: string;
  name?: string;
  content: string;
  timestamp: number;
  groupId?: string;
  groupName?: string;
}

export class ConversationService {
  private conversationHistory: Map<string, Message[]> = new Map();
  private MESSAGE_RETENTION_COUNT: number;
  private CONVERSATION_RETENTION_MS = 24 * 60 * 60 * 1000;
  private conversationsDir: string;
  private databaseService: DatabaseService | null = null;

  constructor(messageRetentionCount: number, databaseService?: DatabaseService) {
    this.MESSAGE_RETENTION_COUNT = messageRetentionCount;
    this.conversationsDir = path.join(__dirname, "../../data/conversations");
    this.databaseService = databaseService || null;
    this.ensureConversationsDirectory();
    this.loadConversationsFromDisk();
  }

  ensureConversationsDirectory(): void {
    try {
      if (!fs.existsSync(this.conversationsDir)) {
        fs.mkdirSync(this.conversationsDir, { recursive: true });
        console.log(
          `Created conversations directory: ${this.conversationsDir}`
        );
      }
    } catch (error) {
      console.error("Error creating conversations directory:", error);
    }
  }

  getConversationFilePath(date: Date): string {
    const dateStr = date.toISOString().split("T")[0];
    return path.join(this.conversationsDir, `conversations-${dateStr}.json`);
  }

  loadConversationsFromDisk(): void {
    try {
      if (!fs.existsSync(this.conversationsDir)) {
        return;
      }

      const files = fs.readdirSync(this.conversationsDir);
      const conversationFiles = files.filter(
        (file) => file.startsWith("conversations-") && file.endsWith(".json")
      );

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      for (const file of conversationFiles) {
        const filePath = path.join(this.conversationsDir, file);
        const conversations = JSON.parse(fs.readFileSync(filePath, "utf8"));

        for (const [conversationId, messages] of Object.entries(
          conversations
        )) {
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

      console.log(
        `Loaded ${this.conversationHistory.size} conversations from disk`
      );
    } catch (error) {
      console.error("Error loading conversations from disk:", error);
    }
  }

  async getConversationsForDate(date: Date): Promise<Record<string, Message[]>> {
    // Try database first if available
    if (this.databaseService) {
      try {
        const dbConversations = await this.databaseService.getConversationsForDate(date);
        // Convert database format to expected format
        const result: Record<string, Message[]> = {};
        for (const [conversationId, messages] of Object.entries(dbConversations)) {
          result[conversationId] = messages.map((msg) => ({
            role: msg.role,
            name: msg.name,
            content: msg.content,
            timestamp: msg.timestamp,
            groupId: msg.groupId,
            groupName: msg.groupName,
          }));
        }
        return result;
      } catch (error) {
        console.error("[ConversationService] Error getting conversations from database:", error);
        // Fall through to file-based approach
      }
    }

    // Fallback to file-based approach
    try {
      const filePath = this.getConversationFilePath(date);

      if (!fs.existsSync(filePath)) {
        return {};
      }

      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      console.error("Error reading conversations for date:", error);
      return {};
    }
  }

  async getConversationsForDateRange(
    startDate: Date,
    endDate: Date
  ): Promise<Record<string, Message[]>> {
    // Try database first if available
    if (this.databaseService) {
      try {
        const dbConversations = await this.databaseService.getConversationsForDateRange(
          startDate,
          endDate
        );
        // Convert database format to expected format
        const result: Record<string, Message[]> = {};
        for (const [conversationId, messages] of Object.entries(dbConversations)) {
          result[conversationId] = messages.map((msg) => ({
            role: msg.role,
            name: msg.name,
            content: msg.content,
            timestamp: msg.timestamp,
            groupId: msg.groupId,
            groupName: msg.groupName,
          }));
        }
        return result;
      } catch (error) {
        console.error("[ConversationService] Error getting conversations from database:", error);
        // Fall through to file-based approach
      }
    }

    // Fallback: combine file-based conversations for date range
    const result: Record<string, Message[]> = {};
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateConversations = await this.getConversationsForDate(currentDate);
      for (const [conversationId, messages] of Object.entries(dateConversations)) {
        if (!result[conversationId]) {
          result[conversationId] = [];
        }
        result[conversationId].push(...messages);
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
    return result;
  }

  async addMessageToHistory(
    conversationId: string,
    message: Message
  ): Promise<void> {
    // Update in-memory cache first (fast access)
    if (!this.conversationHistory.has(conversationId)) {
      this.conversationHistory.set(conversationId, []);
    }

    const history = this.conversationHistory.get(conversationId) || [];
    history.push(message);

    // Keep only recent messages in memory (respect retention count)
    if (history.length > this.MESSAGE_RETENTION_COUNT) {
      const trimmedHistory = history.slice(history.length - this.MESSAGE_RETENTION_COUNT);
      this.conversationHistory.set(conversationId, trimmedHistory);
    } else {
      this.conversationHistory.set(conversationId, history);
    }

    // Save to database if available (async, don't block)
    if (this.databaseService) {
      // Don't await - let it run in background for better performance
      this.databaseService.addConversationMessage({
        conversationId,
        role: message.role,
        name: message.name,
        content: message.content,
        timestamp: message.timestamp,
        groupId: message.groupId,
        groupName: message.groupName,
      }).catch((error) => {
        console.error("[ConversationService] Error saving message to database:", error);
        // Fallback to file-based approach on error
        this.saveConversationsForDate(new Date(message.timestamp));
      });
      // Skip file write when database is available (reduces I/O)
    } else {
      // Only save to disk if database is not available
      this.saveConversationsForDate(new Date(message.timestamp));
    }
  }

  async getConversationHistory(conversationId: string, limit?: number): Promise<Message[]> {
    // Use cache-first strategy for better performance
    const cachedHistory = this.conversationHistory.get(conversationId);
    
    // If we have recent messages in cache, use them (faster)
    if (cachedHistory && cachedHistory.length > 0) {
      // Check if cache is fresh (has recent messages)
      const latestMessage = cachedHistory[cachedHistory.length - 1];
      const cacheAge = Date.now() - latestMessage.timestamp;
      
      // If cache is less than 5 minutes old, use it directly
      if (cacheAge < 5 * 60 * 1000) {
        // Apply limit if specified
        if (limit && limit > 0) {
          return cachedHistory.slice(-limit);
        }
        return cachedHistory;
      }
    }

    // If cache is stale or empty, refresh from database
    if (this.databaseService) {
      try {
        const fetchLimit = limit || this.MESSAGE_RETENTION_COUNT;
        const dbMessages = await this.databaseService.getConversationHistory(
          conversationId,
          fetchLimit
        );
        
        if (dbMessages.length > 0) {
          // Convert to Message format and update cache
          const messages = dbMessages.map((msg) => ({
            role: msg.role,
            name: msg.name,
            content: msg.content,
            timestamp: msg.timestamp,
            groupId: msg.groupId,
            groupName: msg.groupName,
          }));
          
          // Update cache for future requests (store full history)
          this.conversationHistory.set(conversationId, messages);
          
          // Return limited if requested
          if (limit && limit > 0 && messages.length > limit) {
            return messages.slice(-limit);
          }
          return messages;
        }
      } catch (error) {
        console.error("[ConversationService] Error getting history from database:", error);
        // Fall through to in-memory cache
      }
    }

    // Fallback to in-memory cache (even if stale, better than nothing)
    const result = cachedHistory || [];
    if (limit && limit > 0) {
      return result.slice(-limit);
    }
    return result;
  }

  // Synchronous version for backward compatibility (uses in-memory cache only)
  getConversationHistorySync(conversationId: string): Message[] {
    return this.conversationHistory.get(conversationId) || [];
  }

  cleanupOldConversations(): void {
    const currentTime = Date.now();
    let deletedCount = 0;

    for (const [
      conversationId,
      history,
    ] of this.conversationHistory.entries()) {
      if (history.length === 0) {
        this.conversationHistory.delete(conversationId);
        deletedCount++;
        continue;
      }

      const lastMessageTime = Math.max(
        ...history.map((msg) => msg.timestamp || 0)
      );
      if (currentTime - lastMessageTime > this.CONVERSATION_RETENTION_MS) {
        this.conversationHistory.delete(conversationId);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      console.log({
        type: "ConversationCleanup",
        deletedConversations: deletedCount,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private saveConversationsForDate(date: Date): void {
    try {
      const dateStr = date.toISOString().split("T")[0];
      const filePath = this.getConversationFilePath(date);

      // Get all conversations that have messages on this date
      const dateConversations: Record<string, Message[]> = {};

      for (const [
        conversationId,
        messages,
      ] of this.conversationHistory.entries()) {
        const dateMessages = messages.filter((msg) => {
          const msgDate = new Date(msg.timestamp).toISOString().split("T")[0];
          return msgDate === dateStr;
        });

        if (dateMessages.length > 0) {
          dateConversations[conversationId] = dateMessages;
        }
      }

      // Load existing and merge
      let existingConversations: Record<string, Message[]> = {};
      if (fs.existsSync(filePath)) {
        try {
          existingConversations = JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch (error) {
          console.error(
            `[ConversationService] Error reading existing file:`,
            error
          );
        }
      }

      // Merge conversations
      for (const [conversationId, messages] of Object.entries(
        dateConversations
      )) {
        if (!existingConversations[conversationId]) {
          existingConversations[conversationId] = [];
        }

        // Add new messages, avoiding duplicates
        for (const message of messages) {
          const exists = existingConversations[conversationId].some(
            (m) =>
              m.timestamp === message.timestamp && m.content === message.content
          );
          if (!exists) {
            existingConversations[conversationId].push(message);
          }
        }

        // Sort by timestamp
        existingConversations[conversationId].sort(
          (a, b) => a.timestamp - b.timestamp
        );
      }

      // Save to file
      fs.writeFileSync(
        filePath,
        JSON.stringify(existingConversations, null, 2)
      );
    } catch (error) {
      console.error(
        "[ConversationService] Error saving conversations for date:",
        error
      );
    }
  }
}
