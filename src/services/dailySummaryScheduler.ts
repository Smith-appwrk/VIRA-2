import { App, IPlugin } from "@microsoft/teams.apps";
import { CONFIG } from "../config";
import { KnowledgeBaseReviewService } from "./knowledgeBaseReviewService";
import { DatabaseService } from "./databaseService";
import { ConversationReference, MessageActivity } from "@microsoft/teams.api";

export class DailySummaryScheduler {
  private kbReviewService: KnowledgeBaseReviewService;
  private databaseService?: DatabaseService;
  private intervalId: NodeJS.Timeout | null = null;
  private lastSummaryDate: string = "";
  private pendingSummary: { summary: any; message: string } | null = null;

  constructor(
    kbReviewService: KnowledgeBaseReviewService,
    databaseService?: DatabaseService
  ) {
    this.kbReviewService = kbReviewService;
    this.databaseService = databaseService;
  }

  start(app: App<IPlugin>): void {
    if (!CONFIG.KNOWLEDGE_ANALYSIS_ENABLED) {
      console.log("[Scheduler] Knowledge analysis is disabled");
      return;
    }

    if (!CONFIG.KNOWLEDGE_REVIEW_GROUP_ID) {
      console.log("[Scheduler] Knowledge review group ID not configured");
      return;
    }

    console.log("[Scheduler] Starting daily summary scheduler");

    // Check every minute if it's time to send summary
    this.intervalId = setInterval(() => {
      this.checkAndSendSummary(app);
    }, 60000); // Check every minute
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[Scheduler] Daily summary scheduler stopped");
    }
  }

  private async checkAndSendSummary(app: App<IPlugin>): Promise<void> {
    try {
      const now = new Date();
      const currentDate = now.toISOString().split("T")[0];
      console.log("[Scheduler] Current date:", currentDate);
      console.log(
        "[Scheduler] Daily analysis time:",
        CONFIG.DAILY_ANALYSIS_TIME
      );
      const [hours, minutes] =
        CONFIG.DAILY_ANALYSIS_TIME.split(":").map(Number);

      // Check if it's time to send summary and we haven't sent one today
      // Allow a 2-minute window to account for timing
      const timeMatch =
        now.getHours() === hours &&
        now.getMinutes() >= minutes &&
        now.getMinutes() < minutes + 2;

      if (timeMatch && this.lastSummaryDate !== currentDate) {
        console.log("[Scheduler] Time to send daily summary");

        // Check for pending summaries (sent but not reviewed)
        let summaryToSend: string | null = null;
        let summaryId: string | null = null;

        if (this.databaseService) {
          try {
            // Check for summaries with "sent" status from yesterday
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            const sentSummaries =
              await this.databaseService.getKBSummariesByStatus("sent", 10);

            // Filter summaries from yesterday or earlier that are still pending
            const pendingSummaries = sentSummaries.filter((s) => {
              const summaryDate = new Date(s.date);
              return summaryDate < now;
            });

            if (pendingSummaries.length > 0) {
              // Check if we need to consolidate multiple days
              const oldestPending =
                pendingSummaries[pendingSummaries.length - 1];
              const oldestDate = new Date(oldestPending.date);
              const daysDiff = Math.floor(
                (now.getTime() - oldestDate.getTime()) / (24 * 60 * 60 * 1000)
              );

              if (daysDiff >= 2) {
                // Send consolidated 2-day summary
                console.log(
                  "[Scheduler] Consolidating summaries for multiple days"
                );
                const consolidatedSummary =
                  await this.generateConsolidatedSummary(oldestDate, now);
                summaryToSend = consolidatedSummary.summary;
                summaryId = consolidatedSummary.summaryId;
              } else if (daysDiff === 1) {
                // Send consolidated summary for yesterday
                console.log("[Scheduler] Consolidating summary for yesterday");
                const consolidatedSummary =
                  await this.generateConsolidatedSummary(yesterday, yesterday);
                summaryToSend = consolidatedSummary.summary;
                summaryId = consolidatedSummary.summaryId;
              } else {
                // Use existing pending summary
                summaryToSend = oldestPending.summaryText;
                summaryId = oldestPending.summaryId;
              }
            }
          } catch (error) {
            console.error(
              "[Scheduler] Error checking pending summaries:",
              error
            );
          }
        }

        // If no pending summary, generate new one for today
        if (!summaryToSend) {
          const summary = await this.kbReviewService.generateDailySummary(now);
          if (summary && summary.length > 0) {
            summaryToSend = summary;
            // Store summary in database
            if (this.databaseService) {
              summaryId = await this.kbReviewService.createAndStoreSummary(
                now,
                summary
              );
            }
          }
        }

        // Send summary if available
        if (app && summaryToSend && summaryToSend.length > 0) {
          try {
            const messageText = this.formatSummaryMessage(
              summaryToSend,
              summaryId
            );
            await app.send(
              CONFIG.KNOWLEDGE_REVIEW_GROUP_ID,
              new MessageActivity(messageText)
            );

            // Update messageId if we have it
            if (this.databaseService && summaryId) {
              // Message ID would be available from the send response, but we'll update status
              // The messageId will be updated when we receive the response
            }

            this.pendingSummary = {
              summary: { summaryId: summaryId || `summary_${currentDate}` },
              message: messageText,
            };
          } catch (error) {
            console.log("[Scheduler] Error sending summary:", error);
          }
        }
        this.lastSummaryDate = currentDate;
      }
    } catch (error) {
      console.error("[Scheduler] Error checking summary schedule:", error);
    }
  }

  private async generateConsolidatedSummary(
    startDate: Date,
    endDate: Date
  ): Promise<{ summary: string; summaryId: string }> {
    // Use the KB review service to generate summary for date range
    // We'll generate it by getting conversations and using the service's methods
    const conversationService = (this.kbReviewService as any)
      .conversationService;
    const openaiService = (this.kbReviewService as any).openaiService;
    const azureSearchService = (this.kbReviewService as any).azureSearchService;

    // Get conversations for the date range
    const conversations =
      await conversationService.getConversationsForDateRange(
        startDate,
        endDate
      );

    if (Object.keys(conversations).length === 0) {
      return {
        summary: "No conversations found for the specified date range.",
        summaryId: `consolidated_${startDate.toISOString().split("T")[0]}_${
          endDate.toISOString().split("T")[0]
        }`,
      };
    }

    // Generate summary using OpenAI with structured JSON format
    const newKnowledge = await openaiService.getCompletion([
      {
        role: "system",
        content: `You are a knowledge base curator. Extract Q&A pairs from user conversations and return them as a JSON array.

IMPORTANT: 
- Return ONLY valid JSON array format
- DO NOT include any explanatory text before or after the JSON
- Each Q&A pair must be unique and valuable
- Skip casual conversations, greetings, or non-informative messages
- Format: [{"question": "question text", "answer": "answer text"}, ...]

Example format:
[
  {
    "question": "QR code not getting scanned",
    "answer": "- Avoid using any QR scanning app\n- Hold mobile camera steady in front of QR code until a link popup appears\n- Try using Google Lens as an alternative (access via Google.com camera icon)"
  },
  {
    "question": "Finding inbound load number",
    "answer": "- Check BOL document (number typically starts with 019)\n- You can also enter shipment number starting with 034\n- Contact Gate agent if unable to find"
  }
]`,
      },
      {
        role: "user",
        content:
          "DO NOT INCLUDE REPEATED QUESTIONS AND ANSWERS. ONLY UNIQUE QUESTIONS AND ANSWERS. Extract Q&A pairs from the following conversations (consolidated from multiple days) and return as JSON array: " +
          JSON.stringify(conversations),
      },
    ]);

    // Parse structured JSON and filter duplicates
    let uniqueKnowledgeText = "";
    if (azureSearchService) {
      const qaPairs = this.parseStructuredQAPairs(newKnowledge);
      const uniquePairs: Array<{ question: string; answer: string }> = [];

      // Filter duplicates using score threshold (0.85 = 85% similarity)
      for (const pair of qaPairs) {
        const searchQuery = `${pair.question} ${pair.answer}`;
        const searchResults = await azureSearchService.hybridSearch(
          searchQuery,
          1, // topK = 1
          0.85 // threshold - only returns if similarity >= 85%
        );

        // If no results (score < threshold), it's unique
        if (searchResults.length === 0) {
          uniquePairs.push(pair);
        } else {
          console.log(
            `[Scheduler] Discarding duplicate (score: ${searchResults[0].score.toFixed(
              3
            )}): ${pair.question.substring(0, 50)}...`
          );
        }
      }

      uniqueKnowledgeText = uniquePairs
        .map((pair) => `Q: ${pair.question}\nA: ${pair.answer}`)
        .join("\n\n");
    } else {
      // Fallback: parse as text if no Azure Search
      const qaPairs = this.parseQAPairs(newKnowledge);
      uniqueKnowledgeText = qaPairs
        .map((pair) => `Q: ${pair.question}\nA: ${pair.answer}`)
        .join("\n\n");
    }

    const summaryId = `consolidated_${startDate.toISOString().split("T")[0]}_${
      endDate.toISOString().split("T")[0]
    }_${Date.now()}`;

    // Store consolidated summary
    if (this.databaseService) {
      await this.databaseService.createKBSummary({
        summaryId,
        date: endDate.toISOString().split("T")[0],
        summaryText: uniqueKnowledgeText,
        status: "sent",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return {
      summary: uniqueKnowledgeText,
      summaryId,
    };
  }

  private formatSummaryMessage(
    summary: string,
    summaryId: string | null
  ): string {
    const dateStr = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    let message = `📋 **Daily Knowledge Base Review - ${dateStr}**\n\n`;
    message += `${summary}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `**✅ How to respond:**\n`;
    message += `• Reply **"Approved"** to add all entries to the knowledge base\n`;
    message += `• Reply **"Rejected"** to discard all entries\n`;
    message += `• Reply **"Changes Required [your changes]"** to request modifications\n`;
    if (summaryId) {
      message += `\nSummary ID: \`${summaryId}\``;
    }

    return message;
  }

  getPendingSummary(): { summary: any; message: string } | null {
    const summary = this.pendingSummary;
    this.pendingSummary = null; // Clear after retrieval
    return summary;
  }

  /**
   * Parse structured JSON Q&A pairs from OpenAI response
   * Handles both JSON array format and fallback to text parsing
   */
  private parseStructuredQAPairs(
    response: string
  ): Array<{ question: string; answer: string }> {
    try {
      // Try to parse as JSON first (preferred format)
      const trimmed = response.trim();

      // Extract JSON from response if there's extra text
      const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
      const jsonText = jsonMatch ? jsonMatch[0] : trimmed;

      const parsed = JSON.parse(jsonText);

      if (Array.isArray(parsed)) {
        return parsed
          .filter((item) => item.question && item.answer)
          .map((item) => ({
            question: String(item.question).trim(),
            answer: String(item.answer).trim(),
          }));
      }
    } catch (error) {
      console.warn(
        "[Scheduler] Failed to parse structured JSON, falling back to text parsing:",
        error
      );
      // Fallback to text parsing if JSON parsing fails
      return this.parseQAPairs(response);
    }

    return [];
  }

  /**
   * Parse Q&A pairs from text format (fallback method)
   * Expected format: Q: question\nA: answer
   */
  private parseQAPairs(
    text: string
  ): Array<{ question: string; answer: string }> {
    const pairs: Array<{ question: string; answer: string }> = [];
    const lines = text.split("\n");

    let currentQuestion: string | null = null;
    let currentAnswer: string[] = [];

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (/^Q\s*:\s*/.test(trimmedLine)) {
        if (currentQuestion && currentAnswer.length > 0) {
          pairs.push({
            question: currentQuestion,
            answer: currentAnswer.join("\n").trim(),
          });
        }

        currentQuestion = trimmedLine.replace(/^Q\s*:\s*/, "").trim();
        currentAnswer = [];
      } else if (/^A\s*:\s*/.test(trimmedLine)) {
        if (currentQuestion) {
          currentAnswer.push(trimmedLine.replace(/^A\s*:\s*/, "").trim());
        }
      } else if (currentQuestion && currentAnswer.length > 0) {
        currentAnswer.push(trimmedLine);
      } else if (currentQuestion && currentAnswer.length === 0) {
        currentQuestion += " " + trimmedLine;
      }
    }

    if (currentQuestion && currentAnswer.length > 0) {
      pairs.push({
        question: currentQuestion,
        answer: currentAnswer.join("\n").trim(),
      });
    }

    return pairs;
  }
}
