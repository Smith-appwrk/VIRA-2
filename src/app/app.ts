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
    const requestId = `token-${Date.now()}-${Math.random()
      .toString(36)
      .substring(7)}`;
    console.log(`[App] [${requestId}] Token acquisition started:`, {
      scope: Array.isArray(scope) ? scope : [scope],
      tenantId: tenantId || "NOT PROVIDED",
      clientId: process.env.CLIENT_ID
        ? `${process.env.CLIENT_ID.substring(0, 8)}...`
        : "NOT SET",
    });

    try {
      const managedIdentityCredential = new ManagedIdentityCredential({
        clientId: process.env.CLIENT_ID,
      });
      console.log(`[App] [${requestId}] ManagedIdentityCredential created`);

      const scopes = Array.isArray(scope) ? scope : [scope];
      console.log(`[App] [${requestId}] Requesting token with scopes:`, scopes);

      const tokenResponse = await managedIdentityCredential.getToken(scopes, {
        tenantId: tenantId,
      });

      console.log(`[App] [${requestId}] Token response received:`, {
        hasToken: !!tokenResponse?.token,
        tokenLength: tokenResponse?.token?.length || 0,
        expiresOn: tokenResponse?.expiresOnTimestamp
          ? new Date(tokenResponse.expiresOnTimestamp).toISOString()
          : "NOT SET",
      });

      if (!tokenResponse || !tokenResponse.token) {
        console.error(
          `[App] [${requestId}] ⚠️  CRITICAL: Token response is empty!`,
          {
            tokenResponse: tokenResponse
              ? "EXISTS BUT NO TOKEN"
              : "NULL/UNDEFINED",
          }
        );
        throw new Error("Token response is empty");
      }

      console.log(
        `[App] [${requestId}] Token acquisition successful, token prefix:`,
        tokenResponse.token.substring(0, 20) + "..."
      );
      return tokenResponse.token;
    } catch (error: any) {
      console.error(`[App] [${requestId}] ⚠️  ERROR getting token:`, {
        errorType: error?.constructor?.name,
        errorMessage: error?.message,
        errorCode: error?.code,
        errorName: error?.name,
        stack: error?.stack?.split("\n").slice(0, 5).join("\n"),
      });
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

  // Log authentication state at message receipt
  console.log("[App] Authentication state at message receipt:", {
    clientId: process.env.CLIENT_ID
      ? `${process.env.CLIENT_ID.substring(0, 8)}...`
      : "NOT SET",
    microsoftAppType: CONFIG.MicrosoftAppType,
    hasTokenCredentials: !!tokenCredentials,
    hasCredentialOptions: !!credentialOptions,
    tenantId: activity.conversation?.tenantId,
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
      console.log("[App] Sending NO_ANSWER response:", {
        conversationId,
        textLength: errorText.length,
        hasMentions: CONFIG.SUPPORT_USERS.length > 0,
      });
      try {
        await send(errorActivity);
        console.log("[App] NO_ANSWER response sent successfully");
      } catch (sendError: any) {
        console.error("[App] ERROR sending NO_ANSWER response:", {
          errorType: sendError?.constructor?.name,
          errorMessage: sendError?.message,
          errorCode: sendError?.code,
          status: sendError?.status || sendError?.response?.status,
          authHeader:
            sendError?.config?.headers?.Authorization ||
            sendError?.config?.headers?.authorization,
        });
        throw sendError; // Re-throw to be caught by outer catch
      }
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

    console.log("[App] Sending main response:", {
      conversationId,
      responseLength: finalResponse.length,
      attachmentsCount: attachments.length,
      hasGraph: !!graphPath,
      hasImages: relevantImages.length > 0,
    });
    try {
      await send(responseActivity);
      console.log("[App] Main response sent successfully");
    } catch (sendError: any) {
      console.error("[App] ERROR sending main response:", {
        errorType: sendError?.constructor?.name,
        errorMessage: sendError?.message,
        errorCode: sendError?.code,
        status: sendError?.status || sendError?.response?.status,
        authHeader:
          sendError?.config?.headers?.Authorization ||
          sendError?.config?.headers?.authorization,
        requestUrl: sendError?.config?.url,
      });
      throw sendError; // Re-throw to be caught by outer catch
    }

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
    // Intense logging for error diagnosis
    console.error("=".repeat(80));
    console.error("[App] ERROR PROCESSING MESSAGE - DETAILED LOG");
    console.error("[App] Timestamp:", new Date().toISOString());
    console.error("=".repeat(80));

    // Basic error information
    console.error(
      "[App] Error Type:",
      error?.constructor?.name || typeof error
    );
    console.error("[App] Error Message:", error?.message || String(error));
    console.error("[App] Error Code:", error?.code);
    console.error(
      "[App] Error Status:",
      error?.status || error?.response?.status
    );
    console.error(
      "[App] Error Status Text:",
      error?.statusText || error?.response?.statusText
    );

    // Activity context
    console.error("[App] Activity Context:", {
      conversationId: activity.conversation?.id,
      conversationType: activity.conversation?.conversationType,
      tenantId: activity.conversation?.tenantId,
      fromId: activity.from?.id,
      fromName: activity.from?.name,
      channelId: activity.channelId,
      activityType: activity.type,
      text: activity.text?.substring(0, 100), // First 100 chars
    });

    // Axios-specific error details
    if (error?.isAxiosError || error?.config) {
      console.error("[App] Axios Error Details:");
      console.error(
        "  - Request URL:",
        error?.config?.url || error?.request?.path
      );
      console.error(
        "  - Request Method:",
        error?.config?.method?.toUpperCase()
      );

      // Detailed header analysis
      const headers = error?.config?.headers || {};
      console.error(
        "  - Request Headers (full):",
        JSON.stringify(headers, null, 2)
      );

      const authHeader = headers.Authorization || headers.authorization;
      console.error("  - Authorization Header (raw):", authHeader);
      console.error("  - Authorization Header Type:", typeof authHeader);
      console.error(
        "  - Authorization Header Length:",
        authHeader?.length || 0
      );

      if (authHeader) {
        if (authHeader === "Bearer null" || authHeader === "Bearer undefined") {
          console.error(
            "  - ⚠️  CRITICAL: NULL/UNDEFINED TOKEN DETECTED IN AUTHORIZATION HEADER!"
          );
          console.error(
            "  - This indicates token acquisition failed or returned null/undefined"
          );
        } else if (authHeader.startsWith("Bearer ")) {
          const tokenPart = authHeader.substring(7);
          console.error(
            "  - Token Prefix:",
            tokenPart.substring(0, 20) + "..."
          );
          console.error("  - Token Length:", tokenPart.length);
        } else {
          console.error(
            "  - Authorization header format unexpected:",
            authHeader.substring(0, 50)
          );
        }
      } else {
        console.error("  - ⚠️  CRITICAL: NO AUTHORIZATION HEADER FOUND!");
      }

      console.error(
        "  - Request Data:",
        error?.config?.data
          ? typeof error?.config?.data === "string"
            ? error.config.data.substring(0, 500)
            : JSON.stringify(error.config.data).substring(0, 500)
          : "N/A"
      );

      // Response details
      if (error?.response) {
        console.error("  - Response Status:", error.response.status);
        console.error("  - Response Status Text:", error.response.statusText);
        console.error(
          "  - Response Headers:",
          JSON.stringify(error.response.headers || {}, null, 2)
        );
        console.error(
          "  - Response Data:",
          JSON.stringify(error.response.data || {}, null, 2)
        );
      }

      // Request object details
      if (error?.request) {
        console.error("  - Request Host:", error.request.host);
        console.error("  - Request Path:", error.request.path);
        console.error("  - Request Method:", error.request.method);
        console.error("  - Request Headers Sent:", error.request._header);
      }
    }

    // Token-related information - EXTENSIVE
    console.error("[App] Authentication Context - DETAILED:");
    console.error(
      "  - CLIENT_ID env:",
      process.env.CLIENT_ID
        ? `${process.env.CLIENT_ID.substring(0, 8)}...`
        : "NOT SET"
    );
    console.error(
      "  - CLIENT_ID full length:",
      process.env.CLIENT_ID?.length || 0
    );
    console.error("  - MicrosoftAppType:", CONFIG.MicrosoftAppType);
    console.error("  - Has Token Factory:", !!createTokenFactory);
    console.error(
      "  - Token Credentials ClientId:",
      tokenCredentials?.clientId
        ? `${tokenCredentials.clientId.substring(0, 8)}...`
        : "NOT SET"
    );
    console.error(
      "  - Token Credentials Token Factory:",
      typeof tokenCredentials?.token
    );
    console.error(
      "  - Credential Options:",
      credentialOptions ? "SET" : "NOT SET"
    );
    console.error("  - App Credentials:", app ? "APP EXISTS" : "NO APP");

    // Try to diagnose token acquisition
    try {
      const tokenFactory = createTokenFactory();
      console.error("  - Token Factory Created:", !!tokenFactory);
      console.error("  - Token Factory Type:", typeof tokenFactory);

      // Try to get a token (this might fail, but we'll catch it)
      try {
        const testScope = "https://api.botframework.com/.default";
        const testTenantId = activity.conversation?.tenantId;
        console.error("  - Attempting test token acquisition...");
        console.error("    Scope:", testScope);
        console.error("    TenantId:", testTenantId || "NOT PROVIDED");

        const testToken = await tokenFactory(testScope, testTenantId);
        console.error(
          "    Token Acquired:",
          testToken
            ? `YES (length: ${testToken.length})`
            : "NO - RETURNED NULL/UNDEFINED"
        );
        console.error(
          "    Token Prefix:",
          testToken ? testToken.substring(0, 20) + "..." : "N/A"
        );

        if (!testToken) {
          console.error(
            "    ⚠️  CRITICAL: Token factory returned null/undefined!"
          );
        }
      } catch (tokenAcqError: any) {
        console.error("    ⚠️  Token Acquisition FAILED:");
        console.error("      Error Type:", tokenAcqError?.constructor?.name);
        console.error("      Error Message:", tokenAcqError?.message);
        console.error("      Error Code:", tokenAcqError?.code);
        console.error(
          "      Error Stack:",
          tokenAcqError?.stack?.split("\n").slice(0, 5).join("\n")
        );
      }
    } catch (tokenError: any) {
      console.error("  - ⚠️  Token Factory Creation FAILED:");
      console.error("    Error Type:", tokenError?.constructor?.name);
      console.error("    Error Message:", tokenError?.message);
      console.error(
        "    Error Stack:",
        tokenError?.stack?.split("\n").slice(0, 5).join("\n")
      );
    }

    // Check Managed Identity environment
    console.error("[App] Managed Identity Environment:");
    console.error(
      "  - MSI_ENDPOINT:",
      process.env.MSI_ENDPOINT ? "SET" : "NOT SET"
    );
    console.error(
      "  - MSI_SECRET:",
      process.env.MSI_SECRET ? "SET" : "NOT SET"
    );
    console.error(
      "  - IDENTITY_ENDPOINT:",
      process.env.IDENTITY_ENDPOINT ? "SET" : "NOT SET"
    );
    console.error(
      "  - IDENTITY_HEADER:",
      process.env.IDENTITY_HEADER ? "SET" : "NOT SET"
    );

    // Stack trace with more context
    console.error("[App] Stack Trace (first 30 lines):");
    if (error?.stack) {
      const stackLines = error.stack.split("\n");
      stackLines.slice(0, 30).forEach((line: string, idx: number) => {
        console.error(`  [${idx + 1}] ${line}`);
      });
    } else {
      console.error("  No stack trace available");
    }

    // Full error object (limited depth to avoid circular references)
    try {
      const errorString = JSON.stringify(
        error,
        Object.getOwnPropertyNames(error),
        2
      );
      console.error(
        "[App] Full Error Object (first 3000 chars):",
        errorString.substring(0, 3000)
      );
    } catch (stringifyError) {
      console.error("[App] Could not stringify error object:", stringifyError);
    }

    console.error("=".repeat(80));

    // Attempt to send error message, but catch any errors from send itself
    try {
      console.error("[App] Attempting to send error message to user...");
      await send(
        "Sorry, I encountered an error while processing your message. Please try again."
      );
      console.error("[App] Error message sent successfully");
    } catch (sendError: any) {
      console.error(
        "[App] ⚠️  CRITICAL: Failed to send error message to user!"
      );
      console.error("[App] Send Error Type:", sendError?.constructor?.name);
      console.error("[App] Send Error Message:", sendError?.message);
      console.error("[App] Send Error Code:", sendError?.code);
      console.error(
        "[App] Send Error Status:",
        sendError?.status || sendError?.response?.status
      );
      if (sendError?.config) {
        const sendAuthHeader =
          sendError.config.headers?.Authorization ||
          sendError.config.headers?.authorization;
        console.error("[App] Send Error Authorization Header:", sendAuthHeader);
        console.error(
          "[App] Send Error Authorization State:",
          sendAuthHeader === "Bearer null" ||
            sendAuthHeader === "Bearer undefined"
            ? "NULL TOKEN - AUTHENTICATION FAILURE"
            : "OK"
        );
        console.error("[App] Send Error Request URL:", sendError.config.url);
        console.error(
          "[App] Send Error Request Method:",
          sendError.config.method
        );
      }
      console.error(
        "[App] This indicates a potential authentication/authorization issue with the Teams API"
      );
      console.error(
        "[App] Root cause likely: Token acquisition failed or returned null/undefined"
      );
    }
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
