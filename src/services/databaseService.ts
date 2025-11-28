import sql from "mssql";
import { CONFIG } from "../config";

export interface ConversationMessage {
  id?: number;
  conversationId: string;
  role: string;
  name?: string;
  content: string;
  timestamp: number;
  groupId?: string;
  groupName?: string;
}

export interface KBSummary {
  id?: number;
  summaryId: string;
  date: string;
  summaryText: string;
  status: "sent" | "approved" | "rejected" | "changes_required" | "approved_and_modified";
  messageId?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  changes?: string;
  createdAt: number;
  updatedAt: number;
}

export class DatabaseService {
  private pool: sql.ConnectionPool | null = null;
  private isInitialized: boolean = false;

  async initialize(): Promise<void> {
    if (this.isInitialized && this.pool) {
      return;
    }

    if (
      !CONFIG.WRITABLE_DB_HOST ||
      !CONFIG.WRITABLE_DB_NAME ||
      !CONFIG.WRITABLE_DB_USERNAME ||
      !CONFIG.WRITABLE_DB_PASSWORD
    ) {
      console.warn(
        "[DatabaseService] SQL Server configuration not found, database features will be disabled"
      );
      return;
    }

    try {
      const config: sql.config = {
        server: CONFIG.WRITABLE_DB_HOST,
        database: CONFIG.WRITABLE_DB_NAME,
        user: CONFIG.WRITABLE_DB_USERNAME,
        password: CONFIG.WRITABLE_DB_PASSWORD.replace(/^['"]|['"]$/g, ""), // Remove quotes if present
        options: {
          encrypt: true,
          trustServerCertificate: false,
          enableArithAbort: true,
        },
        pool: {
          max: 10,
          min: 0,
          idleTimeoutMillis: 30000,
        },
      };

      this.pool = await sql.connect(config);
      this.isInitialized = true;
      console.log("[DatabaseService] Connected to SQL Server");

      // Initialize database schema
      await this.initializeSchema();
    } catch (error) {
      console.error("[DatabaseService] Error connecting to SQL Server:", error);
      throw error;
    }
  }

  private async initializeSchema(): Promise<void> {
    if (!this.pool) return;

    try {
      // Create conversations table
      await this.pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[conversations]') AND type in (N'U'))
        BEGIN
          CREATE TABLE [dbo].[conversations] (
            [id] INT IDENTITY(1,1) PRIMARY KEY,
            [conversationId] NVARCHAR(500) NOT NULL,
            [role] NVARCHAR(50) NOT NULL,
            [name] NVARCHAR(255) NULL,
            [content] NVARCHAR(MAX) NOT NULL,
            [timestamp] BIGINT NOT NULL,
            [groupId] NVARCHAR(500) NULL,
            [groupName] NVARCHAR(255) NULL,
            INDEX IX_conversations_conversationId ([conversationId]),
            INDEX IX_conversations_timestamp ([timestamp]),
            INDEX IX_conversations_groupId ([groupId])
          )
        END
      `);

      // Create kb_summaries table
      await this.pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[kb_summaries]') AND type in (N'U'))
        BEGIN
          CREATE TABLE [dbo].[kb_summaries] (
            [id] INT IDENTITY(1,1) PRIMARY KEY,
            [summaryId] NVARCHAR(255) NOT NULL UNIQUE,
            [date] NVARCHAR(50) NOT NULL,
            [summaryText] NVARCHAR(MAX) NOT NULL,
            [status] NVARCHAR(50) NOT NULL DEFAULT 'sent',
            [messageId] NVARCHAR(500) NULL,
            [reviewedBy] NVARCHAR(255) NULL,
            [reviewedAt] BIGINT NULL,
            [changes] NVARCHAR(MAX) NULL,
            [createdAt] BIGINT NOT NULL,
            [updatedAt] BIGINT NOT NULL,
            INDEX IX_kb_summaries_date ([date]),
            INDEX IX_kb_summaries_status ([status]),
            INDEX IX_kb_summaries_summaryId ([summaryId])
          )
        END
      `);

      console.log("[DatabaseService] Database schema initialized");
    } catch (error) {
      console.error("[DatabaseService] Error initializing schema:", error);
      throw error;
    }
  }

  async addConversationMessage(message: ConversationMessage): Promise<void> {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }

    try {
      await this.pool.request()
        .input("conversationId", sql.NVarChar, message.conversationId)
        .input("role", sql.NVarChar, message.role)
        .input("name", sql.NVarChar, message.name || null)
        .input("content", sql.NVarChar(sql.MAX), message.content)
        .input("timestamp", sql.BigInt, message.timestamp)
        .input("groupId", sql.NVarChar, message.groupId || null)
        .input("groupName", sql.NVarChar, message.groupName || null)
        .query(`
          INSERT INTO [dbo].[conversations] 
          (conversationId, role, name, content, timestamp, groupId, groupName)
          VALUES 
          (@conversationId, @role, @name, @content, @timestamp, @groupId, @groupName)
        `);
    } catch (error) {
      console.error("[DatabaseService] Error adding conversation message:", error);
      throw error;
    }
  }

  async getConversationHistory(
    conversationId: string,
    limit: number = 20
  ): Promise<ConversationMessage[]> {
    if (!this.pool) {
      return [];
    }

    try {
      const result = await this.pool.request()
        .input("conversationId", sql.NVarChar, conversationId)
        .input("limit", sql.Int, limit)
        .query(`
          SELECT TOP (@limit) 
            id, conversationId, role, name, content, timestamp, groupId, groupName
          FROM [dbo].[conversations]
          WHERE conversationId = @conversationId
          ORDER BY timestamp DESC
        `);

      return result.recordset.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        role: row.role,
        name: row.name,
        content: row.content,
        timestamp: Number(row.timestamp),
        groupId: row.groupId,
        groupName: row.groupName,
      })).reverse(); // Reverse to get chronological order
    } catch (error) {
      console.error("[DatabaseService] Error getting conversation history:", error);
      return [];
    }
  }

  async getConversationsForDate(date: Date): Promise<Record<string, ConversationMessage[]>> {
    if (!this.pool) {
      return {};
    }

    try {
      const dateStr = date.toISOString().split("T")[0];
      const startTimestamp = new Date(dateStr).getTime();
      const endTimestamp = startTimestamp + 24 * 60 * 60 * 1000 - 1;

      const result = await this.pool.request()
        .input("startTimestamp", sql.BigInt, startTimestamp)
        .input("endTimestamp", sql.BigInt, endTimestamp)
        .query(`
          SELECT 
            id, conversationId, role, name, content, timestamp, groupId, groupName
          FROM [dbo].[conversations]
          WHERE timestamp >= @startTimestamp AND timestamp <= @endTimestamp and role != 'assistant'
          ORDER BY timestamp ASC
        `);

      const conversations: Record<string, ConversationMessage[]> = {};

      for (const row of result.recordset) {
        const conversationId = row.conversationId;
        if (!conversations[conversationId]) {
          conversations[conversationId] = [];
        }

        conversations[conversationId].push({
          id: row.id,
          conversationId: row.conversationId,
          role: row.role,
          name: row.name,
          content: row.content,
          timestamp: Number(row.timestamp),
          groupId: row.groupId,
          groupName: row.groupName,
        });
      }

      return conversations;
    } catch (error) {
      console.error("[DatabaseService] Error getting conversations for date:", error);
      return {};
    }
  }

  async getConversationsForDateRange(
    startDate: Date,
    endDate: Date
  ): Promise<Record<string, ConversationMessage[]>> {
    if (!this.pool) {
      return {};
    }

    try {
      const startTimestamp = startDate.getTime();
      const endTimestamp = endDate.getTime() + 24 * 60 * 60 * 1000 - 1;

      const result = await this.pool.request()
        .input("startTimestamp", sql.BigInt, startTimestamp)
        .input("endTimestamp", sql.BigInt, endTimestamp)
        .query(`
          SELECT 
            id, conversationId, role, name, content, timestamp, groupId, groupName
          FROM [dbo].[conversations]
          WHERE timestamp >= @startTimestamp AND timestamp <= @endTimestamp
          ORDER BY timestamp ASC
        `);

      const conversations: Record<string, ConversationMessage[]> = {};

      for (const row of result.recordset) {
        const conversationId = row.conversationId;
        if (!conversations[conversationId]) {
          conversations[conversationId] = [];
        }

        conversations[conversationId].push({
          id: row.id,
          conversationId: row.conversationId,
          role: row.role,
          name: row.name,
          content: row.content,
          timestamp: Number(row.timestamp),
          groupId: row.groupId,
          groupName: row.groupName,
        });
      }

      return conversations;
    } catch (error) {
      console.error("[DatabaseService] Error getting conversations for date range:", error);
      return {};
    }
  }

  async createKBSummary(summary: KBSummary): Promise<void> {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }

    try {
      await this.pool.request()
        .input("summaryId", sql.NVarChar, summary.summaryId)
        .input("date", sql.NVarChar, summary.date)
        .input("summaryText", sql.NVarChar(sql.MAX), summary.summaryText)
        .input("status", sql.NVarChar, summary.status)
        .input("messageId", sql.NVarChar, summary.messageId || null)
        .input("createdAt", sql.BigInt, summary.createdAt)
        .input("updatedAt", sql.BigInt, summary.updatedAt)
        .query(`
          INSERT INTO [dbo].[kb_summaries] 
          (summaryId, date, summaryText, status, messageId, createdAt, updatedAt)
          VALUES 
          (@summaryId, @date, @summaryText, @status, @messageId, @createdAt, @updatedAt)
        `);
    } catch (error) {
      console.error("[DatabaseService] Error creating KB summary:", error);
      throw error;
    }
  }

  async getKBSummary(summaryId: string): Promise<KBSummary | null> {
    if (!this.pool) {
      return null;
    }

    try {
      const result = await this.pool.request()
        .input("summaryId", sql.NVarChar, summaryId)
        .query(`
          SELECT * FROM [dbo].[kb_summaries]
          WHERE summaryId = @summaryId
        `);

      if (result.recordset.length === 0) {
        return null;
      }

      const row = result.recordset[0];
      return {
        id: row.id,
        summaryId: row.summaryId,
        date: row.date,
        summaryText: row.summaryText,
        status: row.status,
        messageId: row.messageId,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt ? Number(row.reviewedAt) : undefined,
        changes: row.changes,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      };
    } catch (error) {
      console.error("[DatabaseService] Error getting KB summary:", error);
      return null;
    }
  }

  async getKBSummaryByMessageId(summaryId: string): Promise<KBSummary | null> {
    if (!this.pool) {
      return null;
    }

    try {
      const result = await this.pool.request()
        .input("summaryId", sql.NVarChar, summaryId)
        .query(`
          SELECT TOP 1 * FROM [dbo].[kb_summaries]
          WHERE summaryId = @summaryId
          ORDER BY createdAt DESC
        `);

      if (result.recordset.length === 0) {
        return null;
      }

      const row = result.recordset[0];
      return {
        id: row.id,
        summaryId: row.summaryId,
        date: row.date,
        summaryText: row.summaryText,
        status: row.status,
        messageId: row.messageId,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt ? Number(row.reviewedAt) : undefined,
        changes: row.changes,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      };
    } catch (error) {
      console.error("[DatabaseService] Error getting KB summary by messageId:", error);
      return null;
    }
  }

  async updateKBSummaryStatus(
    summaryId: string,
    status: KBSummary["status"],
    reviewedBy?: string,
    changes?: string
  ): Promise<void> {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }

    try {
      await this.pool.request()
        .input("summaryId", sql.NVarChar, summaryId)
        .input("status", sql.NVarChar, status)
        .input("reviewedBy", sql.NVarChar, reviewedBy || null)
        .input("reviewedAt", sql.BigInt, reviewedBy ? Date.now() : null)
        .input("changes", sql.NVarChar(sql.MAX), changes || null)
        .input("updatedAt", sql.BigInt, Date.now())
        .query(`
          UPDATE [dbo].[kb_summaries]
          SET status = @status,
              reviewedBy = @reviewedBy,
              reviewedAt = @reviewedAt,
              changes = @changes,
              updatedAt = @updatedAt
          WHERE summaryId = @summaryId
        `);
    } catch (error) {
      console.error("[DatabaseService] Error updating KB summary status:", error);
      throw error;
    }
  }

  async updateKBSummaryMessageId(
    summaryId: string,
    messageId: string
  ): Promise<void> {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }

    try {
      await this.pool.request()
        .input("summaryId", sql.NVarChar, summaryId)
        .input("messageId", sql.NVarChar, messageId)
        .input("updatedAt", sql.BigInt, Date.now())
        .query(`
          UPDATE [dbo].[kb_summaries]
          SET messageId = @messageId,
              updatedAt = @updatedAt
          WHERE summaryId = @summaryId
        `);
    } catch (error) {
      console.error("[DatabaseService] Error updating KB summary messageId:", error);
      throw error;
    }
  }

  async getKBSummariesByStatus(
    status: KBSummary["status"],
    limit: number = 10
  ): Promise<KBSummary[]> {
    if (!this.pool) {
      return [];
    }

    try {
      const result = await this.pool.request()
        .input("status", sql.NVarChar, status)
        .input("limit", sql.Int, limit)
        .query(`
          SELECT TOP (@limit) * FROM [dbo].[kb_summaries]
          WHERE status = @status
          ORDER BY createdAt DESC
        `);

      return result.recordset.map((row) => ({
        id: row.id,
        summaryId: row.summaryId,
        date: row.date,
        summaryText: row.summaryText,
        status: row.status,
        messageId: row.messageId,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt ? Number(row.reviewedAt) : undefined,
        changes: row.changes,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      }));
    } catch (error) {
      console.error("[DatabaseService] Error getting KB summaries by status:", error);
      return [];
    }
  }

  async getKBSummariesForDateRange(
    startDate: Date,
    endDate: Date
  ): Promise<KBSummary[]> {
    if (!this.pool) {
      return [];
    }

    try {
      const startDateStr = startDate.toISOString().split("T")[0];
      const endDateStr = endDate.toISOString().split("T")[0];

      const result = await this.pool.request()
        .input("startDate", sql.NVarChar, startDateStr)
        .input("endDate", sql.NVarChar, endDateStr)
        .query(`
          SELECT * FROM [dbo].[kb_summaries]
          WHERE date >= @startDate AND date <= @endDate
          ORDER BY date ASC, createdAt ASC
        `);

      return result.recordset.map((row) => ({
        id: row.id,
        summaryId: row.summaryId,
        date: row.date,
        summaryText: row.summaryText,
        status: row.status,
        messageId: row.messageId,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt ? Number(row.reviewedAt) : undefined,
        changes: row.changes,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      }));
    } catch (error) {
      console.error("[DatabaseService] Error getting KB summaries for date range:", error);
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
      this.isInitialized = false;
      console.log("[DatabaseService] Database connection closed");
    }
  }
}

