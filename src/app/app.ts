import { App } from "@microsoft/teams.apps";
import { MessageActivity, TokenCredentials } from '@microsoft/teams.api';
import { ManagedIdentityCredential } from '@azure/identity';
import { LocalStorage } from "@microsoft/teams.common";
import * as fs from 'fs';
import * as path from 'path';
import { OpenAIService } from "../services/openaiService";
import { ConversationService } from "../services/conversationService";
import { ImageService } from "../services/imageService";
import { AIAgentService } from "../services/aiAgentService";

import { KnowledgeBaseReviewService } from "../services/knowledgeBaseReviewService";
import { DailySummaryScheduler } from "../services/dailySummaryScheduler";
import { CONFIG } from "../config";
import { HybridGraphService } from "../services/hybridGraphService";

// Create storage for conversation history
const storage = new LocalStorage();

// Initialize services
const openaiService = new OpenAIService(CONFIG.OPENAI_API_KEY || '');
const conversationService = new ConversationService(CONFIG.MESSAGE_RETENTION_COUNT);
const imageService = new ImageService();
const aiAgentService = new AIAgentService(openaiService);
const graphService = new HybridGraphService();
const kbReviewService = new KnowledgeBaseReviewService(openaiService, conversationService);
const dailyScheduler = new DailySummaryScheduler(kbReviewService);

// Load knowledge base and initialize AI Agent
let intelligateContent = '';
try {
  const intelligatePath = path.join(__dirname, '../data/intelligate.md');
  if (fs.existsSync(intelligatePath)) {
    intelligateContent = fs.readFileSync(intelligatePath, 'utf8');
    aiAgentService.initialize(intelligateContent);
    console.log('[App] Knowledge base loaded and AI Agent initialized');
  } else {
    console.warn('[App] intelligate.md not found, AI Agent will work without knowledge base');
  }
} catch (error) {
  console.error('[App] Error loading knowledge base:', error);
}

// Load available images
const imagesDir = path.join(__dirname, '../data/images');
const availableImages: Record<string, string> = {};
try {
  if (fs.existsSync(imagesDir)) {
    const imageFiles = fs.readdirSync(imagesDir);
    imageFiles.forEach(file => {
      const filePath = path.join(imagesDir, file);
      availableImages[file] = filePath;
    });
    console.log(`[App] Loaded ${Object.keys(availableImages).length} reference images`);
  }
} catch (error) {
  console.error('[App] Error loading images:', error);
}

// Load instructions from file on initialization
function loadInstructions(): string {
  const instructionPath = path.join(__dirname, 'instructions.txt');
  if (fs.existsSync(instructionPath)) {
    return fs.readFileSync(instructionPath, 'utf-8').trim();
  }
  return 'You are a helpful assistant.';
}

const instructions = loadInstructions();

const createTokenFactory = () => {
  return async (scope: string | string[], tenantId?: string): Promise<string> => {
    const managedIdentityCredential = new ManagedIdentityCredential({
      clientId: process.env.CLIENT_ID
    });
    const scopes = Array.isArray(scope) ? scope : [scope];
    const tokenResponse = await managedIdentityCredential.getToken(scopes, {
      tenantId: tenantId
    });
    return tokenResponse.token;
  };
};

// Configure authentication using TokenCredentials
const tokenCredentials: TokenCredentials = {
  clientId: process.env.CLIENT_ID || '',
  token: createTokenFactory()
};

const credentialOptions = CONFIG.MicrosoftAppType === "UserAssignedMsi" ? { ...tokenCredentials } : undefined;

const app = new App({
  ...credentialOptions,
  storage
});

// Helper function to check if bot should respond
function shouldRespond(activity: any): boolean {
  const isMentioned = activity.entities?.some((entity: any) =>
    entity.type === 'mention' &&
    entity.mentioned?.id === activity.recipient?.id
  );

  const userName = activity.from?.name?.toLowerCase().replaceAll(' ', '') || '';
  // Use CONFIG.REPLY_TO which is loaded from environment variables
  const shouldReply = CONFIG.REPLY_TO.includes(userName) || isMentioned;

  return shouldReply;
}

// Helper function to check if message is from KB Review group
function isKBReviewGroup(activity: any): boolean {
  const conversationId = activity.conversation?.id || '';
  return conversationId === CONFIG.KNOWLEDGE_REVIEW_GROUP_ID;
}

// Helper function to check if user can review KB
function canReviewKB(activity: any): boolean {
  const userName = activity.from?.name?.toLowerCase().replaceAll(' ', '') || '';
  return CONFIG.KB_REVIEW_USERS.includes(userName);
}

// Store active summaries with their message IDs
const activeSummaries = new Map<string, string>(); // messageId -> summaryId

// Helper function to process user input
async function processUserInput(activity: any, tokenFactory: (scope: string | string[], tenantId?: string) => Promise<string>): Promise<string> {
  let message = activity.text || '';

  // Correct spelling
  message = await openaiService.correctSpelling(message);

  // Handle image attachments
  if (activity.attachments?.length > 0 &&
    activity.attachments[0].contentType?.startsWith('image/')) {
    try {
      const attachment = activity.attachments[0];
      const imageUrl = attachment.contentUrl;

      console.log('[App] Processing image attachment:', {
        imageUrl,
        contentType: attachment.contentType
      });

      const base64Image = await imageService.processImage(imageUrl, tokenFactory);
      const textFromImage = await openaiService.analyzeImage(
        base64Image,
        "Please extract and return: 1) The exact question being asked in the form, and 2) Any error message shown. Format as: Question: [question text] Error: [error message]"
      );

      message += '\n\n' + textFromImage;
      console.log('[App] Successfully processed image and extracted text');
    } catch (imageError: any) {
      console.error('[App] Error processing image:', imageError);
      message += '\n\n[Note: Unable to process the attached image.]';
    }
  }

  // Analyze intent
  const messageIntent = await openaiService.analyzeIntent(message);
  const isMentioned = activity.entities?.some((entity: any) =>
    entity.type === 'mention' &&
    entity.mentioned?.id === activity.recipient?.id
  );

  if (messageIntent === 'IGNORE' && !isMentioned) {
    return '';
  }

  return message;
}

// Helper function to find relevant images
async function findRelevantImages(question: string): Promise<string[]> {
  if (Object.keys(availableImages).length === 0) {
    return [];
  }
  return await openaiService.findRelevantImages(question, availableImages, 3);
}

// Helper function to check if graph is requested
function isGraphRequest(text: string): boolean {
  const graphKeywords = [
    'graph', 'chart', 'plot', 'visual', 'graphical', 'visualization',
    'breakdown', 'distribution', 'show this in graphical format',
    'bar chart', 'pie chart', 'line chart', 'diagram'
  ];
  return graphKeywords.some(keyword => text.toLowerCase().includes(keyword));
}

// Helper function to process graph request
async function processGraphRequest(userQuery: string, response: string): Promise<{ response: string; graphPath: string | null }> {
  console.log('Processing graph request for:', userQuery);

  let graphData = await openaiService.extractGraphDataWithAI(response, userQuery);

  if (!graphData || !graphData.data || graphData.data.length === 0) {
    console.log('AI extraction failed, falling back to regex extraction');
    graphData = openaiService.extractGraphData(response);
  }

  if (!graphData || !graphData.data || graphData.data.length === 0) {
    return {
      response: response,
      graphPath: null
    };
  }

  console.log('Extracted graph data:', JSON.stringify(graphData));

  const chartType = graphData.chartType || 'bar';
  const title = graphData.title ||
    (userQuery.length > 50 ? userQuery.substring(0, 47) + '...' : userQuery);

  try {
    const graphResult = await graphService.generateGraph(
      graphData,
      chartType,
      title
    );

    console.log('Generated graph result:', graphResult);

    if (!graphResult) {
      return {
        response: response + "\n\n📊 I apologize, but I encountered an error while generating the graph.",
        graphPath: null
      };
    }

    return {
      response: response + "\n\n📊 I've generated a professional chart to visualize this data:",
      graphPath: typeof graphResult === 'string' ? graphResult : null
    };
  } catch (error) {
    console.error('Error generating graph:', error);
    return {
      response: response + "\n\n📊 I apologize, but I encountered an error while generating the graph.",
      graphPath: null
    };
  }
}

// Handle incoming messages
app.on('message', async ({ send, activity }) => {
  console.log(`[App] Received message: ${activity.text}`, {
    from: activity.from?.name,
    conversationId: activity.conversation?.id
  });

  // Handle KB Review group messages first
  if (isKBReviewGroup(activity)) {
    await handleKBReviewMessage(send, activity);
    return;
  }

  // Check if bot should respond
  if (!shouldRespond(activity)) {
    console.log('[App] Bot should not respond to this message');
    return;
  }

  const conversationId = activity.conversation?.id || 'default';
  const conversationKey = `${conversationId}/${activity.from?.id}`;
  const storedMessages = storage.get(conversationKey) || [];

  // Convert stored messages to conversation history format
  const conversationHistory = storedMessages.map((msg: any) => ({
    role: msg.role,
    content: msg.content
  }));

  try {
    // Process user input (spelling correction, image analysis, intent)
    const tokenFactory = createTokenFactory();
    const userQuery = await processUserInput(activity, tokenFactory);

    if (!userQuery) {
      console.log('[App] Message filtered out (IGNORE intent)');
      return;
    }

    // Add user message to conversation history
    conversationService.addMessageToHistory(conversationId, {
      role: 'user',
      name: activity.from?.name || 'User',
      content: userQuery,
      timestamp: Date.now(),
      groupId: activity.conversation?.id || null
    });

    // Find relevant images
    const relevantImages = await findRelevantImages(userQuery);
    console.log('[App] Found relevant images:', relevantImages.length);

    // Detect language
    const detectedLanguage = await openaiService.detectLanguage(userQuery);

    // Generate response using AI Agent Service
    let response = await aiAgentService.generateResponse(
      conversationId,
      conversationHistory,
      userQuery,
      detectedLanguage
    );

    // Handle special responses
    if (response === 'NO_ANSWER') {
      const translatedError = detectedLanguage !== 'en' ?
        await openaiService.translateText("I don't have information about that in my knowledge base. Let me notify our support team.", detectedLanguage) :
        "I don't have information about that in my knowledge base. Let me notify our support team.";

      // Add support team mentions
      let errorText = translatedError;
      if (CONFIG.SUPPORT_USERS.length > 0) {
        const mentions = CONFIG.SUPPORT_USERS.map(user => `<at>${user.name}</at>`).join(' ');
        errorText += `\n\n${mentions} - Could you please help with this query?`;
      }

      const errorActivity = new MessageActivity(errorText);
      await send(errorActivity);
      return;
    }

    if (response === 'NEED_SUPPORT') {
      let supportMsg = "Let me notify our support team.";
      if (CONFIG.SUPPORT_USERS.length > 0) {
        const mentions = CONFIG.SUPPORT_USERS.map(user => `<at>${user.name}</at>`).join(' ');
        supportMsg += `\n\n${mentions} - Could you please help with this query?`;
      }
      const supportActivity = new MessageActivity(supportMsg);
      await send(supportActivity);
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
        const base64Image = fs.readFileSync(graphPath, { encoding: 'base64' });
        attachments.push({
          contentType: 'image/png',
          contentUrl: `data:image/png;base64,${base64Image}`,
          name: 'chart.png'
        });
      } catch (error) {
        console.error('[App] Error adding graph attachment:', error);
      }
    }

    // Add relevant images as attachments
    for (const imagePath of relevantImages) {
      if (fs.existsSync(imagePath)) {
        try {
          const base64Image = fs.readFileSync(imagePath, { encoding: 'base64' });
          const ext = path.extname(imagePath).substring(1).toLowerCase() || 'png';
          attachments.push({
            contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
            contentUrl: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64Image}`,
            name: path.basename(imagePath)
          });
        } catch (error) {
          console.error('[App] Error adding image attachment:', error);
        }
      }
    }

    // Add attachments if any
    if (attachments.length > 0) {
      (responseActivity as any).attachments = attachments;
    }

    await send(responseActivity);

    // Update conversation history
    conversationService.addMessageToHistory(conversationId, {
      role: 'assistant',
      content: response,
      timestamp: Date.now(),
      groupId: activity.conversation?.id || null
    });

    // Update storage
    storedMessages.push({
      role: 'user',
      content: userQuery
    });
    storedMessages.push({
      role: 'assistant',
      content: response
    });
    storage.set(conversationKey, storedMessages);

    // Cleanup old conversations
    conversationService.cleanupOldConversations();

  } catch (error: any) {
    console.error('[App] Error processing message:', error);
    await send('Sorry, I encountered an error while processing your message. Please try again.');
  }
});

// Handle KB Review group messages
async function handleKBReviewMessage(send: any, activity: any): Promise<void> {
  try {
    const messageText = activity.text || '';
    const messageId = activity.id;
    const replyToId = activity.replyToId;

    // Check if this is a reply to a summary message
    if (replyToId) {
      // Try to find the summary ID from the reply chain
      let summaryId: string | undefined = activeSummaries.get(replyToId);
      
      // If not found in direct mapping, check if the parent message contains summary info
      // This handles cases where the reply chain might be deeper
      if (!summaryId) {
        // Try to extract from message metadata or check recent summaries
        for (const [msgId, sumId] of activeSummaries.entries()) {
          // In Teams, replyToId might reference a different message in the chain
          // We'll check if any active summary exists
          summaryId = sumId;
          break; // Use the first available summary
        }
      }

      if (summaryId) {
        if (!canReviewKB(activity)) {
          await send('You are not authorized to review knowledge base entries.');
          return;
        }

        const reviewerName = activity.from?.name || 'Unknown';
        const result = await kbReviewService.processReviewResponse(messageText, reviewerName, summaryId);
        
        if (result.processed) {
          await send(result.message);
        } else {
          await send(`Unable to process review: ${result.message}`);
        }
        return;
      }
    }

    // Check if this is a new summary request or if user is asking for summary
    const lowerText = messageText.toLowerCase();
    if (lowerText.includes('summary') || lowerText.includes('review') || lowerText.includes('generate')) {
      if (!canReviewKB(activity)) {
        await send('You are not authorized to request knowledge base summaries.');
        return;
      }
      
      // Trigger summary generation
      await dailyScheduler.triggerSummaryNow();
      const pendingSummary = dailyScheduler.getPendingSummary();
      
      if (pendingSummary) {
        const summaryActivity = new MessageActivity(pendingSummary.message);
        const sentActivity = await send(summaryActivity);
        
        // Store the summary ID with the message ID for reply tracking
        // Use the activity ID if available, otherwise use a generated key
        const key = sentActivity?.id || messageId || `summary_${Date.now()}`;
        activeSummaries.set(key, pendingSummary.summary.summaryId);
        
        // Also store with summary ID for reverse lookup
        console.log(`[App] Stored summary ${pendingSummary.summary.summaryId} with key ${key}`);
      } else {
        await send('No new knowledge entries to review at this time.');
      }
      return;
    }

    // Check for pending summaries to send (when bot receives any message in KB Review group)
    const pendingSummary = dailyScheduler.getPendingSummary();
    if (pendingSummary) {
      const summaryActivity = new MessageActivity(pendingSummary.message);
      const sentActivity = await send(summaryActivity);
      
      if (sentActivity && sentActivity.id) {
        activeSummaries.set(sentActivity.id, pendingSummary.summary.summaryId);
        console.log(`[App] Sent daily summary ${pendingSummary.summary.summaryId} with message ID ${sentActivity.id}`);
      }
    }

  } catch (error: any) {
    console.error('[App] Error handling KB review message:', error);
    await send('Sorry, I encountered an error while processing the knowledge base review.');
  }
}

// Start the daily summary scheduler
if (CONFIG.KNOWLEDGE_ANALYSIS_ENABLED) {
  dailyScheduler.start();
  console.log('[App] Knowledge base review system initialized');
}

export default app;
