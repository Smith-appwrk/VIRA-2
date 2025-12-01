import { App } from "@microsoft/teams.apps";
import {
  IMessageActivity,
  MessageActivity,
  TokenCredentials,
} from "@microsoft/teams.api";
import { ManagedIdentityCredential } from "@azure/identity";
import * as fs from "fs";
import * as path from "path";
import { OpenAIService } from "../services/openaiService";
import { ConversationService } from "../services/conversationService";
import { AIAgentService } from "../services/aiAgentService";
import { AzureSearchService } from "../services/azureSearchService";

import { KnowledgeBaseReviewService } from "../services/knowledgeBaseReviewService";
import { DailySummaryScheduler } from "../services/dailySummaryScheduler";
import { DatabaseService } from "../services/databaseService";
import { CONFIG } from "../config";
import {
  canReviewKB,
  findRelevantImages,
  isGraphRequest,
  isKBReviewGroup,
  processGraphRequest,
  processUserInput,
  shouldRespond,
} from "../utils/helper.utils";

// Initialize services
const openaiService = new OpenAIService(CONFIG.OPENAI_API_KEY || "");
const databaseService = new DatabaseService();

// Initialize database service (async, but don't block)
databaseService
  .initialize()
  .then(() => {
    console.log("[App] Database service initialized");
  })
  .catch((error) => {
    console.error("[App] Error initializing database service:", error);
    console.log(
      "[App] Continuing without database - will use file-based storage"
    );
  });

const conversationService = new ConversationService(
  CONFIG.MESSAGE_RETENTION_COUNT,
  databaseService
);
const azureSearchService = CONFIG.AZURE_SEARCH_ENDPOINT
  ? new AzureSearchService(openaiService)
  : undefined;
const aiAgentService = new AIAgentService(openaiService, azureSearchService);

const kbReviewService = new KnowledgeBaseReviewService(
  openaiService,
  conversationService,
  azureSearchService,
  databaseService
);
const dailyScheduler = new DailySummaryScheduler(
  kbReviewService,
  databaseService
);

aiAgentService
  .initialize("")
  .then(() => {
    console.log("[App] AI Agent initialized with Azure AI Search");
  })
  .catch((error) => {
    console.error("[App] Error initializing AI Agent:", error);
  });

const createTokenFactory = () => {
  return async (
    scope: string | string[],
    tenantId?: string
  ): Promise<string> => {
    try {
      const managedIdentityCredential = new ManagedIdentityCredential({
        clientId: process.env.CLIENT_ID,
      });
      const scopes = Array.isArray(scope) ? scope : [scope];
      const tokenResponse = await managedIdentityCredential.getToken(scopes, {
        tenantId: tenantId,
      });

      if (!tokenResponse || !tokenResponse.token) {
        throw new Error("Token response is empty");
      }

      return tokenResponse.token;
    } catch (error) {
      console.error("[App] Error getting token:", error);
      // Re-throw to prevent undefined token
      throw new Error(
        `Failed to get authentication token: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };
};

// Configure authentication using TokenCredentials
const tokenCredentials: TokenCredentials = {
  clientId: process.env.CLIENT_ID || "",
  token: createTokenFactory(),
};

const credentialOptions =
  CONFIG.MicrosoftAppType === "UserAssignedMsi"
    ? { ...tokenCredentials }
    : undefined;

const app = new App({
  ...credentialOptions,
});

// Handle incoming messages
app.on("message", async ({ send, activity, ...rest }) => {
  console.log(`[App] Received message: ${activity.text}`, {
    from: activity.from?.name,
    conversationId: activity.conversation?.id,
  });

  // Handle KB Review group messages first
  if (isKBReviewGroup(activity)) {
    await handleKBReviewMessage(send, activity);
    return;
  }

  // Check if bot should respond
  if (!shouldRespond(activity)) {
    console.log("[App] Bot should not respond to this message");
    return;
  }

  const conversationId = activity.conversation?.id || "default";

  try {
    // Process user input (spelling correction, image analysis, intent)
    const tokenFactory = createTokenFactory();
    const userQuery = await processUserInput(activity, tokenFactory);

    if (!userQuery) {
      console.log("[App] Message filtered out (IGNORE intent)");
      return;
    }

    // Add user message to conversation history with group chat name
    // Don't await - let it save in background while we process
    const userMessage: any = {
      role: "user",
      name: activity.from?.name || "User",
      content: userQuery,
      timestamp: Date.now(),
      groupId: activity.conversation?.id || null,
    };

    // Add to history (non-blocking)
    conversationService.addMessageToHistory(conversationId, userMessage);

    // Find relevant images
    const relevantImages = await findRelevantImages(userQuery);
    console.log("[App] Found relevant images:", relevantImages.length);

    // Get conversation history (will use cache if available)
    // Since we just added the message, it will be in cache
    // Limit to last 10 messages to avoid token limits and improve performance
    const historyMessages = await conversationService.getConversationHistory(
      conversationId,
      10 // Limit to last 10 messages
    );

    // Format history efficiently - join with newlines
    const history = historyMessages.map((msg) => msg.content).join("\n");

    // Generate response with optimized history
    let response = await aiAgentService.generateResponse(
      conversationId,
      history,
      userQuery
    );
    // Handle special responses
    if (response === "NO_ANSWER") {
      let errorText =
        "I don't have information about that in my knowledge base. Let me notify our support team.";

      if (CONFIG.SUPPORT_USERS.length > 0) {
        const mentions = CONFIG.SUPPORT_USERS.map(
          (user) => `<at>${user.name}</at>`
        ).join(" ");
        errorText += `\n\n${mentions} - Could you please help with this query?`;
      }

      const errorActivity = new MessageActivity(errorText);
      await send(errorActivity);
      return;
    }

    // Check if graph is requested
    let finalResponse = response;
    let graphPath: string | null = null;

    if (isGraphRequest(userQuery)) {
      const graphResult = await processGraphRequest(userQuery, response);
      finalResponse = graphResult.response;
      graphPath = graphResult.graphPath;
    }

    // Create response activity
    const responseActivity = new MessageActivity(finalResponse);

    // Collect all attachments
    const attachments: any[] = [];

    // Add graph as attachment if available
    if (graphPath && fs.existsSync(graphPath)) {
      try {
        const base64Image = fs.readFileSync(graphPath, { encoding: "base64" });
        attachments.push({
          contentType: "image/png",
          contentUrl: `data:image/png;base64,${base64Image}`,
          name: "chart.png",
        });
      } catch (error) {
        console.error("[App] Error adding graph attachment:", error);
      }
    }

    // Add relevant images as attachments
    for (const imagePath of relevantImages) {
      if (fs.existsSync(imagePath)) {
        try {
          const base64Image = fs.readFileSync(imagePath, {
            encoding: "base64",
          });
          const ext =
            path.extname(imagePath).substring(1).toLowerCase() || "png";
          attachments.push({
            contentType: `image/${ext === "jpg" ? "jpeg" : ext}`,
            contentUrl: `data:image/${
              ext === "jpg" ? "jpeg" : ext
            };base64,${base64Image}`,
            name: path.basename(imagePath),
          });
        } catch (error) {
          console.error("[App] Error adding image attachment:", error);
        }
      }
    }

    // Add attachments if any
    if (attachments.length > 0) {
      (responseActivity as any).attachments = attachments;
    }

    await send(responseActivity);

    // Update conversation history with assistant response (non-blocking)
    // Don't await - response is already sent, save in background
    conversationService.addMessageToHistory(conversationId, {
      role: "assistant",
      content: response,
      timestamp: Date.now(),
      groupId: activity.conversation?.id || null,
    });

    // Cleanup old conversations
    // conversationService.cleanupOldConversations();
  } catch (error: any) {
    console.error("[App] Error processing message:", error);
    await send(
      "Sorry, I encountered an error while processing your message. Please try again."
    );
  }
});

// Parse KB Review message format: SummaryID||Action||Changes
export interface ParsedKBReviewMessage {
  summaryId: string;
  action: "approved" | "rejected" | "changes_required";
  changes?: string;
  isValid: boolean;
}

function parseKBReviewMessage(messageText: string): ParsedKBReviewMessage {
  const parts = messageText.split("||").map((p) => p.trim());

  // Handle malformed messages - try to extract summary ID and action
  if (parts.length < 2) {
    // Try to extract from natural language
    const lowerText = messageText.toLowerCase();
    let action: "approved" | "rejected" | "changes_required" | null = null;

    if (lowerText.includes("approved") || lowerText.startsWith("approved")) {
      action = "approved";
    } else if (
      lowerText.includes("rejected") ||
      lowerText.startsWith("rejected")
    ) {
      action = "rejected";
    } else if (
      lowerText.includes("changes required") ||
      lowerText.includes("changes")
    ) {
      action = "changes_required";
    }

    // Try to extract summary ID (look for pattern like "summary_2024-01-01_123456")
    const summaryIdMatch = messageText.match(
      /(summary_[a-z0-9_-]+|consolidated_[0-9-]+)/i
    );
    const summaryId = summaryIdMatch ? summaryIdMatch[1] : parts[0] || "";

    return {
      summaryId,
      action: action || "approved", // Default to approved if unclear
      changes: parts.length > 2 ? parts.slice(2).join("||") : undefined,
      isValid: !!summaryId && !!action,
    };
  }

  const summaryId = parts[0];
  const actionText = parts[1].toLowerCase();
  let action: "approved" | "rejected" | "changes_required";

  if (actionText.includes("approved") || actionText === "approve") {
    action = "approved";
  } else if (actionText.includes("rejected") || actionText === "reject") {
    action = "rejected";
  } else if (actionText.includes("changes") || actionText.includes("change")) {
    action = "changes_required";
  } else {
    // Default to approved if unclear
    action = "approved";
  }

  const changes = parts.length > 2 ? parts.slice(2).join("||") : undefined;

  return {
    summaryId,
    action,
    changes,
    isValid: !!summaryId && summaryId.length > 0,
  };
}

// Handle KB Review group messages
async function handleKBReviewMessage(
  send: any,
  activity: IMessageActivity
): Promise<void> {
  try {
    const messageText = activity.text || "";

    // Parse the message format: SummaryID||Action||Changes
    const parsed = parseKBReviewMessage(messageText);

    if (!parsed.isValid) {
      if (!canReviewKB(activity)) {
        await send(
          "You are not authorized to request knowledge base summaries."
        );
        return;
      }

      const pendingSummary = dailyScheduler.getPendingSummary();
      if (pendingSummary) {
        const summaryActivity = new MessageActivity(pendingSummary.message);
        const sentActivity = await send(summaryActivity);

        // Update messageId in database if we have the summaryId
        if (
          databaseService &&
          sentActivity?.id &&
          pendingSummary.summary.summaryId
        ) {
          try {
            await databaseService.updateKBSummaryMessageId(
              pendingSummary.summary.summaryId,
              sentActivity.id
            );
            console.log(
              `[App] Updated summary ${pendingSummary.summary.summaryId} with message ID ${sentActivity.id}`
            );
          } catch (error) {
            console.error("[App] Error updating summary messageId:", error);
          }
        }
      } else {
        await send("No new knowledge entries to review at this time.");
      }
      return;
    }

    // Check authorization
    if (!canReviewKB(activity)) {
      await send("You are not authorized to review knowledge base entries.");
      return;
    }

    // Get summary from database
    let dbSummary = null;
    if (databaseService) {
      try {
        dbSummary = await databaseService.getKBSummary(parsed.summaryId);
      } catch (error) {
        console.error("[App] Error getting summary from database:", error);
      }
    }

    if (!dbSummary) {
      // Try to find recent summary as fallback
      if (databaseService) {
        try {
          const recentSummaries = await databaseService.getKBSummariesByStatus(
            "sent",
            1
          );
          if (recentSummaries.length > 0) {
            dbSummary = recentSummaries[0];
            console.log(`[App] Using fallback summary: ${dbSummary.summaryId}`);
          }
        } catch (error) {
          console.error("[App] Error getting recent summary:", error);
        }
      }

      if (!dbSummary) {
        await send(
          `Summary not found: ${parsed.summaryId}. Please check the summary ID and try again.`
        );
        return;
      }
    }

    // Process the review
    const reviewerName = activity.from?.name || "Unknown";

    // Build the review message in expected format
    let reviewMessage = `${parsed.summaryId}||${parsed.action}`;
    if (parsed.changes) {
      reviewMessage += `||${parsed.changes}`;
    }

    const result = await kbReviewService.processReviewResponse(
      reviewerName,
      parsed
    );

    if (result.processed) {
      await send(result.message);
    } else {
      await send(`Unable to process review: ${result.message}`);
    }
  } catch (error: any) {
    console.error("[App] Error handling KB review message:", error);
    await send(
      "Sorry, I encountered an error while processing the knowledge base review."
    );
  }
}

// Start the daily summary scheduler
if (CONFIG.KNOWLEDGE_ANALYSIS_ENABLED) {
  dailyScheduler.start(app);
  console.log("[App] Knowledge base review system initialized");
}

export default app;
