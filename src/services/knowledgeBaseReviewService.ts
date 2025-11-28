import * as fs from "fs";
import * as path from "path";
import { OpenAIService } from "./openaiService";
import { ConversationService } from "./conversationService";
import { AzureSearchService, KnowledgeDocument } from "./azureSearchService";
import { DatabaseService, KBSummary } from "./databaseService";
import { CONFIG } from "../config";
import { ParsedKBReviewMessage } from "../app/app";

export interface KnowledgeEntry {
  id: string;
  question: string;
  answer: string;
  source: string; // conversation ID or group ID
  timestamp: number;
  status: "pending" | "approved" | "rejected" | "changes_required";
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
  private azureSearchService?: AzureSearchService;
  private databaseService?: DatabaseService;
  private pendingEntries: Map<string, KnowledgeEntry> = new Map();
  private dailySummaries: Map<string, DailySummary> = new Map();
  private storagePath: string;
  private useVectorSearch: boolean = false;

  constructor(
    openaiService: OpenAIService,
    conversationService: ConversationService,
    azureSearchService?: AzureSearchService,
    databaseService?: DatabaseService
  ) {
    this.openaiService = openaiService;
    this.conversationService = conversationService;
    this.azureSearchService = azureSearchService;
    this.databaseService = databaseService;
    this.useVectorSearch =
      !!CONFIG.AZURE_SEARCH_ENDPOINT && !!azureSearchService;
    this.storagePath = path.join(__dirname, "../../data/kb_review");
    this.ensureStorageDirectory();
    this.loadPendingEntries();
  }

  private ensureStorageDirectory(): void {
    try {
      if (!fs.existsSync(this.storagePath)) {
        fs.mkdirSync(this.storagePath, { recursive: true });
        console.log(
          `[KBReview] Created storage directory: ${this.storagePath}`
        );
      }
    } catch (error) {
      console.error("[KBReview] Error creating storage directory:", error);
    }
  }

  private loadPendingEntries(): void {
    try {
      const filePath = path.join(this.storagePath, "pending_entries.json");
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        for (const [id, entry] of Object.entries(data)) {
          this.pendingEntries.set(id, entry as KnowledgeEntry);
        }
        console.log(
          `[KBReview] Loaded ${this.pendingEntries.size} pending entries`
        );
      }
    } catch (error) {
      console.error("[KBReview] Error loading pending entries:", error);
    }
  }

  private savePendingEntries(): void {
    try {
      const filePath = path.join(this.storagePath, "pending_entries.json");
      const data: Record<string, KnowledgeEntry> = {};
      for (const [id, entry] of this.pendingEntries.entries()) {
        data[id] = entry;
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("[KBReview] Error saving pending entries:", error);
    }
  }

  async extractKnowledgeFromConversation(
    conversationId: string,
    messages: Array<{
      role: string;
      content: string;
      name?: string;
      timestamp?: number;
    }>
  ): Promise<KnowledgeEntry[]> {
    const entries: KnowledgeEntry[] = [];

    // Filter out assistant messages - we only want user conversations
    const userMessages = messages.filter((msg) => msg.role === "user");

    if (userMessages.length === 0) {
      return entries;
    }

    // Analyze the conversation in chunks to find valuable knowledge
    // Look at windows of messages to capture multi-message exchanges
    const windowSize = 5; // Look at up to 5 consecutive user messages at a time

    for (let i = 0; i < userMessages.length; i++) {
      // Single message analysis - could be standalone info
      const singleMsg = userMessages[i];
      const singleMsgValuable = await this.isValuableStandaloneMessage(
        singleMsg.content,
        singleMsg.name
      );

      if (singleMsgValuable.isValuable) {
        const entryId = `${conversationId}_${Date.now()}_single_${i}`;
        const entry: KnowledgeEntry = {
          id: entryId,
          question: singleMsgValuable.topic || "Information shared",
          answer: singleMsg.content.trim(),
          source: conversationId,
          timestamp: singleMsg.timestamp || Date.now(),
          status: "pending",
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
            status: "pending",
          };
          entries.push(entry);
          // Skip the messages we just processed
          i += exchange.messagesUsed - 1;
        }
      }
    }

    return entries;
  }

  private async isValuableStandaloneMessage(
    content: string,
    userName?: string
  ): Promise<{ isValuable: boolean; topic?: string }> {
    try {
      // Skip very short messages
      if (content.trim().length < 20) {
        return { isValuable: false };
      }

      // Skip common greetings and casual messages
      const casualPatterns =
        /^(hey|hi|hello|thanks|thank you|ok|okay|any|sure|yes|no|any new updates)/i;
      if (casualPatterns.test(content.trim())) {
        return { isValuable: false };
      }

      const prompt = `Analyze if this message contains valuable information that should be added to a knowledge base.

Message: "${content}"
From: ${userName || "Unknown user"}

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
        {
          role: "system",
          content:
            "You are a knowledge base curator. Identify valuable standalone information. Always return valid JSON.",
        },
        { role: "user", content: prompt },
      ]);

      const parsed = JSON.parse(response.trim());
      return parsed;
    } catch (error) {
      console.error("[KBReview] Error evaluating standalone message:", error);
      return { isValuable: false };
    }
  }

  private async extractQAFromUserMessages(
    messages: Array<{
      role: string;
      content: string;
      name?: string;
      timestamp?: number;
    }>
  ): Promise<{
    question: string;
    answer: string;
    messagesUsed: number;
  } | null> {
    try {
      // Build conversation text
      const conversationText = messages
        .map((msg, idx) => `[${idx}] ${msg.name || "User"}: ${msg.content}`)
        .join("\n");

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
        {
          role: "system",
          content:
            "You are a knowledge base curator. Extract Q&A pairs from user conversations. Always return valid JSON.",
        },
        { role: "user", content: prompt },
      ]);

      const parsed = JSON.parse(response.trim());

      if (parsed.hasQA && parsed.question && parsed.answer) {
        return {
          question: parsed.question,
          answer: parsed.answer,
          messagesUsed: parsed.messagesUsed || 2,
        };
      }

      return null;
    } catch (error) {
      console.error(
        "[KBReview] Error extracting Q&A from user messages:",
        error
      );
      return null;
    }
  }

  async addKnowledgeEntry(entry: KnowledgeEntry): Promise<void> {
    this.pendingEntries.set(entry.id, entry);
    this.savePendingEntries();
    console.log(`[KBReview] Added new knowledge entry: ${entry.id}`);
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
        "[KBReview] Failed to parse structured JSON, falling back to text parsing:",
        error
      );
      // Fallback to text parsing if JSON parsing fails
      return this.parseQAPairs(response);
    }

    return [];
  }

  /**
   * Filter out duplicate/repeated messages within conversations
   * Returns conversations with only unique messages
   */
  private filterUniqueConversations(
    conversations: Record<
      string,
      Array<{ role: string; content: string; timestamp: number }>
    >
  ): Record<
    string,
    Array<{ role: string; content: string; timestamp: number }>
  > {
    const uniqueConversations: Record<
      string,
      Array<{ role: string; content: string; timestamp: number }>
    > = {};
    const seenMessages = new Set<string>();

    for (const [conversationId, messages] of Object.entries(conversations)) {
      const uniqueMessages: Array<{
        role: string;
        content: string;
        timestamp: number;
      }> = [];

      for (const message of messages) {
        // Normalize message content for comparison (lowercase, trim)
        const normalizedContent = message.content.toLowerCase().trim();

        // Skip if message is too short or empty
        if (normalizedContent.length < 10) {
          continue;
        }

        // Create a hash-like key from normalized content
        const messageKey = `${message.role}:${normalizedContent}`;

        // Only add if we haven't seen this exact message before
        if (!seenMessages.has(messageKey)) {
          seenMessages.add(messageKey);
          uniqueMessages.push(message);
        } else {
          console.log(
            `[KBReview] Skipping duplicate message: "${message.content.substring(
              0,
              50
            )}..."`
          );
        }
      }

      if (uniqueMessages.length > 0) {
        uniqueConversations[conversationId] = uniqueMessages;
      }
    }

    const originalCount = Object.values(conversations).reduce(
      (sum, msgs) => sum + msgs.length,
      0
    );
    const uniqueCount = Object.values(uniqueConversations).reduce(
      (sum, msgs) => sum + msgs.length,
      0
    );

    console.log(
      `[KBReview] Filtered ${originalCount} messages to ${uniqueCount} unique messages (removed ${
        originalCount - uniqueCount
      } duplicates)`
    );

    return uniqueConversations;
  }

  /**
   * Filter duplicate Q&A pairs using VectorDB with STRICT matching and LLM validation
   * Only keeps pairs that are NOT duplicates in VectorDB
   * Uses multiple search strategies to catch duplicates:
   * 1. Search by question only (most important - catches exact question matches)
   * 2. Search by question + answer combined
   * 3. LLM validation for final confirmation
   */
  private async filterDuplicatePairs(
    qaPairs: Array<{ question: string; answer: string }>
  ): Promise<Array<{ question: string; answer: string }>> {
    // If Azure Search is not available, return all pairs
    if (!this.useVectorSearch || !this.azureSearchService) {
      console.log(
        "[KBReview] Azure Search not available, skipping duplicate check"
      );
      return qaPairs;
    }

    if (qaPairs.length === 0) {
      return [];
    }

    try {
      const uniquePairs: Array<{ question: string; answer: string }> = [];
      // STRICT threshold: 0.75 = 75% similarity required to consider potential duplicate
      // Lower than 0.85 to catch more potential matches, but LLM will validate strictly
      const SEARCH_THRESHOLD = 0.75;

      // Check each Q&A pair against Azure Search index with strict matching
      for (const pair of qaPairs) {
        let allSearchResults: Array<{
          question?: string;
          answer?: string;
          content: string;
          score: number;
        }> = [];

        // Strategy 1: Search by QUESTION only (most important - catches exact question matches)
        // This is critical because VectorDB stores questions separately
        console.log(
          `[KBReview] Checking question: "${pair.question.substring(0, 60)}..."`
        );
        const questionResults = await this.azureSearchService.hybridSearch(
          pair.question,
          5, // Get more results for question matching
          SEARCH_THRESHOLD
        );

        if (questionResults.length > 0) {
          console.log(
            `[KBReview] Found ${
              questionResults.length
            } potential matches for question (scores: ${questionResults
              .map((r) => r.score.toFixed(3))
              .join(", ")})`
          );
          allSearchResults.push(...questionResults);
        }

        // Strategy 2: Search by QUESTION + ANSWER combined (catches full Q&A duplicates)
        const combinedQuery = `${pair.question} ${pair.answer}`;
        const combinedResults = await this.azureSearchService.hybridSearch(
          combinedQuery,
          3,
          SEARCH_THRESHOLD
        );

        if (combinedResults.length > 0) {
          console.log(
            `[KBReview] Found ${
              combinedResults.length
            } potential matches for Q&A combined (scores: ${combinedResults
              .map((r) => r.score.toFixed(3))
              .join(", ")})`
          );
          // Merge results, avoiding duplicates
          for (const result of combinedResults) {
            const exists = allSearchResults.some(
              (r) =>
                r.question === result.question && r.answer === result.answer
            );
            if (!exists) {
              allSearchResults.push(result);
            }
          }
        }

        // Remove duplicates from search results (same question/answer)
        const uniqueResults = Array.from(
          new Map(
            allSearchResults.map((r) => [
              `${r.question || ""}_${r.answer || ""}`,
              r,
            ])
          ).values()
        );

        if (uniqueResults.length === 0) {
          // No similar content found, keep this Q&A pair
          uniquePairs.push(pair);
          console.log(
            `[KBReview] ✓ Keeping unique Q&A (no match found above ${SEARCH_THRESHOLD} threshold): "${pair.question.substring(
              0,
              50
            )}..."`
          );
        } else {
          // Found potential duplicates - validate with LLM for STRICT matching
          console.log(
            `[KBReview] Found ${uniqueResults.length} potential duplicate(s), validating with LLM...`
          );

          const isDuplicate = await this.validateDuplicateWithLLM(
            pair,
            uniqueResults
          );

          if (!isDuplicate) {
            // LLM confirmed it's NOT a duplicate, keep it
            uniquePairs.push(pair);
            console.log(
              `[KBReview] ✓ Keeping unique Q&A (LLM validation passed - not a duplicate): "${pair.question.substring(
                0,
                50
              )}..."`
            );
          } else {
            // Confirmed duplicate, discard
            const matchScore = uniqueResults[0].score;
            console.log(
              `[KBReview] ✗ DISCARDING duplicate Q&A (similarity: ${matchScore.toFixed(
                3
              )}, LLM confirmed DUPLICATE): "${pair.question.substring(
                0,
                50
              )}..."`
            );
            console.log(
              `[KBReview]   Existing match: "${
                uniqueResults[0].question ||
                uniqueResults[0].content.substring(0, 50)
              }..."`
            );
          }
        }
      }

      console.log(
        `[KBReview] Filtered ${qaPairs.length} Q&A pairs to ${
          uniquePairs.length
        } unique pairs (removed ${
          qaPairs.length - uniquePairs.length
        } duplicates)`
      );

      return uniquePairs;
    } catch (error) {
      console.error(
        "[KBReview] Error filtering duplicate pairs, returning all pairs:",
        error
      );
      return qaPairs; // Return all pairs on error
    }
  }

  /**
   * Use LLM to validate if a Q&A pair is truly a duplicate of existing knowledge
   * Returns true if duplicate, false if unique
   * Uses VERY STRICT criteria - only marks as duplicate if information is essentially identical
   */
  private async validateDuplicateWithLLM(
    pair: { question: string; answer: string },
    searchResults: Array<{
      question?: string;
      answer?: string;
      content: string;
      score: number;
    }>
  ): Promise<boolean> {
    if (!this.openaiService) {
      // If no OpenAI service, use score-based decision (conservative)
      return searchResults[0].score >= 0.9; // Very high threshold if no LLM
    }

    try {
      // Format existing knowledge for comparison
      const existingKnowledge = searchResults
        .map((result, idx) => {
          const q = result.question || "";
          const a = result.answer || result.content || "";
          const score = result.score.toFixed(3);
          return `[Existing Knowledge ${
            idx + 1
          } - Similarity Score: ${score}]\nQuestion: ${q}\nAnswer: ${a}`;
        })
        .join("\n\n");

      const prompt = `You are an EXTREMELY STRICT duplicate detector for a knowledge base. Your job is to determine if the NEW Q&A pair is essentially the SAME as existing knowledge already in the VectorDB.

CRITICAL RULES - BE VERY STRICT:
1. Return "DUPLICATE" ONLY if:
   - The question asks the EXACT SAME thing (even if worded slightly differently)
   - The answer provides the EXACT SAME information/steps/solution
   - The information is functionally identical (same steps, same process, same outcome)

2. Return "UNIQUE" if:
   - The question is different (even slightly)
   - The answer adds NEW information, different steps, or different context
   - The answer provides additional details not in existing knowledge
   - The information is similar but NOT identical

3. Examples:
   - "How to scan license?" vs "How to scan a license?" → DUPLICATE (same question, same answer)
   - "Scan license" vs "Scan driver's license" → DUPLICATE if answer is same
   - "How to scan license?" vs "How to scan passport?" → UNIQUE (different question)
   - Same question but answer has additional steps → UNIQUE (new information)

NEW Q&A Pair to Check:
Question: "${pair.question}"
Answer: "${pair.answer}"

Existing Knowledge from VectorDB (already stored):
${existingKnowledge}

IMPORTANT: If the question is asking the SAME thing and the answer provides the SAME information/steps, it's a DUPLICATE. Only return "UNIQUE" if there's genuinely NEW or DIFFERENT information.

Respond with ONLY one word: "DUPLICATE" or "UNIQUE"`;

      const response = await this.openaiService.getCompletion([
        {
          role: "system",
          content: `You are an EXTREMELY STRICT duplicate detector. Your goal is to PREVENT duplicate knowledge entries. 
Only mark as "DUPLICATE" if the information is truly identical. When in doubt, mark as "DUPLICATE" to prevent duplicates.`,
        },
        { role: "user", content: prompt },
      ]);

      const responseUpper = response.trim().toUpperCase();
      const isDuplicate =
        responseUpper.includes("DUPLICATE") &&
        !responseUpper.includes("UNIQUE");

      console.log(
        `[KBReview] LLM duplicate validation result: ${
          isDuplicate ? "DUPLICATE" : "UNIQUE"
        } for "${pair.question.substring(0, 50)}..."`
      );
      console.log(`[KBReview] LLM response: "${response.trim()}"`);

      // If LLM is uncertain or response is unclear, default to DUPLICATE to be safe
      if (
        !responseUpper.includes("DUPLICATE") &&
        !responseUpper.includes("UNIQUE")
      ) {
        console.log(
          `[KBReview] WARNING: LLM response unclear, defaulting to DUPLICATE to prevent duplicates`
        );
        return true; // Default to duplicate to be safe
      }

      return isDuplicate;
    } catch (error) {
      console.error("[KBReview] Error in LLM duplicate validation:", error);
      // On error, use score-based decision (conservative - mark as duplicate if score is high)
      // Use very high threshold (0.90) to be safe
      const shouldMarkDuplicate = searchResults[0].score >= 0.9;
      console.log(
        `[KBReview] Error in LLM validation, using score-based decision: ${
          shouldMarkDuplicate ? "DUPLICATE" : "UNIQUE"
        } (score: ${searchResults[0].score.toFixed(3)})`
      );
      return shouldMarkDuplicate;
    }
  }

  /**
   * Parse Q&A pairs from text format
   * Handles both formats:
   * 1. Multi-line: Q: question\nA: answer
   * 2. Single-line: Q: question A: answer Q: question2 A: answer2
   */
  private parseQAPairs(
    text: string
  ): Array<{ question: string; answer: string }> {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const pairs: Array<{ question: string; answer: string }> = [];

    // First, try to detect if it's single-line format (Q: ... A: ... Q: ... A: ...)
    // Check if there are multiple Q: patterns on the same line or consecutive lines without newlines
    const hasMultipleQOnSameLine = text.split("\n").some((line) => {
      const qMatches = line.match(/Q\s*:/gi);
      return qMatches && qMatches.length > 1;
    });

    // If single-line format detected, parse accordingly
    if (
      hasMultipleQOnSameLine ||
      (!text.includes("\n") && text.match(/Q\s*:.*A\s*:.*Q\s*:/i))
    ) {
      console.log("[KBReview] Detected single-line Q&A format, parsing...");
      return this.parseSingleLineQAPairs(text);
    }

    // Otherwise, parse multi-line format
    const lines = text.split("\n");
    let currentQuestion: string | null = null;
    let currentAnswer: string[] = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) continue;

      // Check if line starts with "Q:" or "Q :"
      if (/^Q\s*:\s*/.test(trimmedLine)) {
        // Save previous pair if exists
        if (currentQuestion && currentAnswer.length > 0) {
          pairs.push({
            question: currentQuestion,
            answer: currentAnswer.join("\n").trim(),
          });
        }

        // Start new question
        currentQuestion = trimmedLine.replace(/^Q\s*:\s*/i, "").trim();
        currentAnswer = [];
      }
      // Check if line starts with "A:" or "A :"
      else if (/^A\s*:\s*/.test(trimmedLine)) {
        // If we have a question, start collecting answer
        if (currentQuestion) {
          currentAnswer.push(trimmedLine.replace(/^A\s*:\s*/i, "").trim());
        }
      }
      // If we're collecting an answer, add this line
      else if (currentQuestion && currentAnswer.length > 0) {
        currentAnswer.push(trimmedLine);
      }
      // If we have a question but no answer started yet, this might be continuation of question
      else if (currentQuestion && currentAnswer.length === 0) {
        currentQuestion += " " + trimmedLine;
      }
    }

    // Don't forget the last pair
    if (currentQuestion && currentAnswer.length > 0) {
      pairs.push({
        question: currentQuestion,
        answer: currentAnswer.join("\n").trim(),
      });
    }

    return pairs;
  }

  /**
   * Parse Q&A pairs from single-line format
   * Format: Q: question A: answer Q: question2 A: answer2
   */
  private parseSingleLineQAPairs(
    text: string
  ): Array<{ question: string; answer: string }> {
    const pairs: Array<{ question: string; answer: string }> = [];

    // Split by Q: markers to get individual Q&A blocks
    // Use positive lookahead to keep the Q: in the split
    const qaBlocks = text.split(/(?=Q\s*:)/i);

    for (const block of qaBlocks) {
      const trimmedBlock = block.trim();
      if (!trimmedBlock || !trimmedBlock.match(/Q\s*:/i)) continue;

      // Extract question (everything after Q: until A:)
      // Use non-greedy match with lookahead for " A:"
      const questionMatch = trimmedBlock.match(/Q\s*:\s*(.*?)(?=\s+A\s*:|$)/is);
      if (!questionMatch) continue;

      const question = questionMatch[1].trim();
      if (question.length === 0) continue;

      // Extract answer (everything after A: until next Q: or end of string)
      // Look for " A:" or " Q:" or end of string
      const answerMatch = trimmedBlock.match(/A\s*:\s*(.*?)(?=\s+Q\s*:|$)/is);
      if (!answerMatch) {
        // Try to get everything after A: if no next Q: found
        const answerMatch2 = trimmedBlock.match(/A\s*:\s*(.*)$/is);
        if (answerMatch2) {
          const answer = answerMatch2[1].trim();
          if (answer.length > 0) {
            pairs.push({
              question: question,
              answer: answer,
            });
          }
        }
        continue;
      }

      const answer = answerMatch[1].trim();

      if (answer.length > 0) {
        pairs.push({
          question: question,
          answer: answer,
        });
      }
    }

    console.log(
      `[KBReview] Parsed ${pairs.length} Q&A pairs from single-line format`
    );

    // Log parsed pairs for debugging
    pairs.forEach((pair, idx) => {
      console.log(
        `[KBReview] Pair ${idx + 1}: Q="${pair.question.substring(
          0,
          50
        )}..." A="${pair.answer.substring(0, 50)}..."`
      );
    });

    return pairs;
  }

  /**
   * Format Q&A pairs back to text format
   */
  private formatQAPairs(
    pairs: Array<{ question: string; answer: string }>
  ): string {
    if (pairs.length === 0) {
      return "";
    }

    return pairs
      .map((pair) => `Q: ${pair.question}\nA: ${pair.answer}`)
      .join("\n\n");
  }

  async generateDailySummary(date: Date = new Date()): Promise<string> {
    const dateStr = date.toISOString().split("T")[0];

    console.log(`[KBReview] Generating summary for ${dateStr}`);

    // Get all pending entries
    const pendingEntries = Array.from(this.pendingEntries.values()).filter(
      (entry) => entry.status === "pending"
    );

    console.log(
      `[KBReview] Found ${pendingEntries.length} existing pending entries`
    );

    // Get conversations from the date
    const rawConversations =
      await this.conversationService.getConversationsForDate(date);
    console.log(
      `[KBReview] Found ${
        Object.keys(rawConversations).length
      } conversations for date ${dateStr}`
    );

    // Step 1: Filter out duplicate/repeated messages within conversations
    const conversations = this.filterUniqueConversations(rawConversations);
    console.log(
      `[KBReview] Filtered to ${
        Object.keys(conversations).length
      } unique conversations (removed duplicates)`
    );

    // Check if summary already exists for this date
    if (this.databaseService) {
      try {
        const existingSummaries =
          await this.databaseService.getKBSummariesForDateRange(date, date);
        // Filter out rejected and approved summaries, keep only sent/changes_required
        const activeSummaries = existingSummaries.filter(
          (s) => s.status === "sent" || s.status === "changes_required"
        );
        if (activeSummaries.length > 0) {
          console.log(
            `[KBReview] Found existing summary for ${dateStr}, returning it`
          );
          return activeSummaries[0].summaryText;
        }
      } catch (error) {
        console.error("[KBReview] Error checking existing summaries:", error);
      }
    }

    // Request structured JSON format from OpenAI instead of text parsing
    const newKnowledge = await this.openaiService.getCompletion([
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
          "DO NOT INCLUDE REPEATED QUESTIONS AND ANSWERS. ONLY UNIQUE QUESTIONS AND ANSWERS. Extract Q&A pairs from the following conversation and return as JSON array: " +
          JSON.stringify(conversations),
      },
    ]);

    // Parse structured JSON instead of text parsing
    const qaPairs = this.parseStructuredQAPairs(newKnowledge);

    // Filter duplicates from Azure Search using score threshold
    const uniquePairs = await this.filterDuplicatePairs(qaPairs);

    // Return formatted text for backward compatibility
    return this.formatQAPairs(uniquePairs);
  }

  async createAndStoreSummary(
    date: Date,
    summaryText: string,
    messageId?: string
  ): Promise<string> {
    const dateStr = date.toISOString().split("T")[0];
    const summaryId = `summary_${dateStr}_${Date.now()}`;

    if (this.databaseService) {
      try {
        await this.databaseService.createKBSummary({
          summaryId,
          date: dateStr,
          summaryText,
          status: "sent",
          messageId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        console.log(`[KBReview] Stored summary ${summaryId} in database`);
      } catch (error) {
        console.error("[KBReview] Error storing summary in database:", error);
      }
    }

    return summaryId;
  }

  async formatSummaryMessage(summary: DailySummary): Promise<string> {
    if (summary.entries.length === 0) {
      return `📋 **Daily Knowledge Base Review - ${summary.date}**\n\nNo new knowledge entries to review today.`;
    }

    let message = `📋 **Daily Knowledge Base Review - ${summary.date}**\n\n`;
    message += `Found ${summary.entries.length} new knowledge ${
      summary.entries.length === 1 ? "entry" : "entries"
    } to review:\n\n`;

    summary.entries.forEach((entry, index) => {
      message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      message += `**Entry ${index + 1}** • ID: \`${entry.id}\`\n\n`;
      message += `**📝 Topic/Question:**\n${entry.question}\n\n`;
      message += `**💡 Information/Answer:**\n${entry.answer}\n\n`;
      message += `**📍 Source:** ${entry.source}\n`;
      message += `**🕐 Time:** ${new Date(
        entry.timestamp
      ).toLocaleString()}\n\n`;
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

  async processReviewResponse(
    reviewerName: string,
    parsed: ParsedKBReviewMessage
  ): Promise<{ processed: boolean; message: string }> {
    let dbSummary: KBSummary | null = null;
    if (this.databaseService) {
      try {
        dbSummary = await this.databaseService.getKBSummary(parsed.summaryId);
      } catch (error) {
        console.error("[KBReview] Error getting summary from database:", error);
      }
    }

    if (!dbSummary) {
      return { processed: false, message: "Summary not found" };
    }

    if (parsed.action === "rejected") {
      return {
        processed: true,
        message: "Summary rejected. No entries added to knowledge base.",
      };
    }

    // Check if user is authorized
    const reviewerNameLower = reviewerName.toLowerCase().replaceAll(" ", "");
    if (!CONFIG.KB_REVIEW_USERS.includes(reviewerNameLower)) {
      return {
        processed: false,
        message: "User not authorized to review knowledge base entries",
      };
    }

    // Process the review action
    if (parsed.action === "approved" || parsed.action === "changes_required") {
      let summaryText = dbSummary.summaryText;

      if (parsed.changes ||
        parsed.changes.trim().length > 10
      ) {
        // Check if user provided modified summary text
        summaryText = parsed.changes;
        if (this.databaseService) {
          await this.databaseService.updateKBSummaryStatus(
            dbSummary.summaryId,
            "changes_required",
            reviewerName,
            parsed.changes
          );
        }
      }
      // Parse Q&A pairs from summary text and add to VectorDB
      const qaPairs = this.parseQAPairs(summaryText);
      let addedCount = 0;

      if (this.azureSearchService && qaPairs.length > 0) {
        try {
          const documents: KnowledgeDocument[] = qaPairs.map((pair, index) => ({
            id: `${dbSummary!.summaryId}_${Date.now()}_${index}`,
            content: pair.answer,
            question: pair.question,
            answer: pair.answer,
            source: dbSummary!.summaryId,
            timestamp: Date.now(),
            status: "approved",
          }));

          await this.azureSearchService.upsertDocuments(documents);
          addedCount = documents.length;
          console.log(
            `[KBReview] Added ${addedCount} Q&A pairs to VectorDB for summary ${dbSummary.summaryId}`
          );
        } catch (error) {
          console.error("[KBReview] Error adding to VectorDB:", error);
        }
      }

      // Update database status
      if (this.databaseService) {
        await this.databaseService.updateKBSummaryStatus(
          dbSummary.summaryId,
          "approved",
          reviewerName
        );
      }

      return {
        processed: true,
        message: `✅ Summary approved. ${addedCount} Q&A pairs added to knowledge base.`,
      };
    } else if (parsed.action === "rejected") {
      // Update database status only
      if (this.databaseService) {
        await this.databaseService.updateKBSummaryStatus(
          dbSummary.summaryId,
          "rejected",
          reviewerName
        );
      }

      return {
        processed: true,
        message: "❌ Summary rejected. No entries added to knowledge base.",
      };
    }
  }

  getPendingEntries(): KnowledgeEntry[] {
    return Array.from(this.pendingEntries.values()).filter(
      (e) => e.status === "pending"
    );
  }

  getSummary(summaryId: string): DailySummary | undefined {
    return this.dailySummaries.get(summaryId);
  }
}
