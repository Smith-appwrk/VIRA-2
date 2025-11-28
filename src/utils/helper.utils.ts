import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "../config";
import { HybridGraphService } from "../services/hybridGraphService";
import { OpenAIService } from "../services/openaiService";
import { ImageService } from "../services/imageService";

// Helper function to check if bot should respond
export function shouldRespond(activity: any): boolean {
  const isMentioned = activity.entities?.some(
    (entity: any) =>
      entity.type === "mention" &&
      entity.mentioned?.id === activity.recipient?.id
  );

  const userName = activity.from?.name?.toLowerCase().replaceAll(" ", "") || "";
  // Use CONFIG.REPLY_TO which is loaded from environment variables
  const shouldReply = CONFIG.REPLY_TO.includes(userName) || isMentioned;

  return shouldReply
}

// Helper function to check if message is from KB Review group
export function isKBReviewGroup(activity: any): boolean {
  const conversationId = activity.conversation?.id || "";
  return conversationId === CONFIG.KNOWLEDGE_REVIEW_GROUP_ID;
}

// Helper function to check if user can review KB
export function canReviewKB(activity: any): boolean {
  const userName = activity.from?.name?.toLowerCase().replaceAll(" ", "") || "";
  return CONFIG.KB_REVIEW_USERS.includes(userName);
}

export function loadAvailableImages(): Record<string, string> {
  // Load available images
  const imagesDir = path.join(__dirname, "../data/images");
  const availableImages: Record<string, string> = {};
  try {
    if (fs.existsSync(imagesDir)) {
      const imageFiles = fs.readdirSync(imagesDir);
      imageFiles.forEach((file) => {
        const filePath = path.join(imagesDir, file);
        availableImages[file] = filePath;
      });
      console.log(
        `[App] Loaded ${Object.keys(availableImages).length} reference images`
      );
    }
  } catch (error) {
    console.error("[App] Error loading images:", error);
  }
  return availableImages;
}

// Helper function to find relevant images
export async function findRelevantImages(question: string): Promise<string[]> {
  const openaiService = new OpenAIService(CONFIG.OPENAI_API_KEY || "");
  const availableImages: Record<string, string> = loadAvailableImages();
  if (Object.keys(availableImages).length === 0) {
    return [];
  }
  return await openaiService.findRelevantImages(question, availableImages, 3);
}

// Helper function to check if graph is requested
export function isGraphRequest(text: string): boolean {
  const graphKeywords = [
    "graph",
    "chart",
    "plot",
    "visual",
    "graphical",
    "visualization",
    "breakdown",
    "distribution",
    "show this in graphical format",
    "bar chart",
    "pie chart",
    "line chart",
    "diagram",
  ];
  return graphKeywords.some((keyword) => text.toLowerCase().includes(keyword));
}

// Helper function to process graph request
export async function processGraphRequest(
  userQuery: string,
  response: string
): Promise<{ response: string; graphPath: string | null }> {
  const openaiService = new OpenAIService(CONFIG.OPENAI_API_KEY || "");
  const graphService = new HybridGraphService();
  console.log("Processing graph request for:", userQuery);

  let graphData = await openaiService.extractGraphDataWithAI(
    response,
    userQuery
  );

  if (!graphData || !graphData.data || graphData.data.length === 0) {
    console.log("AI extraction failed, falling back to regex extraction");
    graphData = openaiService.extractGraphData(response);
  }

  if (!graphData || !graphData.data || graphData.data.length === 0) {
    return {
      response: response,
      graphPath: null,
    };
  }

  console.log("Extracted graph data:", JSON.stringify(graphData));

  const chartType = graphData.chartType || "bar";
  const title =
    graphData.title ||
    (userQuery.length > 50 ? userQuery.substring(0, 47) + "..." : userQuery);

  try {
    const graphResult = await graphService.generateGraph(
      graphData,
      chartType,
      title
    );

    console.log("Generated graph result:", graphResult);

    if (!graphResult) {
      return {
        response:
          response +
          "\n\n📊 I apologize, but I encountered an error while generating the graph.",
        graphPath: null,
      };
    }

    return {
      response:
        response +
        "\n\n📊 I've generated a professional chart to visualize this data:",
      graphPath: typeof graphResult === "string" ? graphResult : null,
    };
  } catch (error) {
    console.error("Error generating graph:", error);
    return {
      response:
        response +
        "\n\n📊 I apologize, but I encountered an error while generating the graph.",
      graphPath: null,
    };
  }
}

// Helper function to process user input
export async function processUserInput(
  activity: any,
  tokenFactory: (scope: string | string[], tenantId?: string) => Promise<string>
): Promise<string> {
  const openaiService = new OpenAIService(CONFIG.OPENAI_API_KEY || "");
  const imageService = new ImageService();
  let message = activity.text || "";

  // Handle image attachments
  if (
    activity.attachments?.length > 0 &&
    activity.attachments[0].contentType?.startsWith("image/")
  ) {
    try {
      const attachment = activity.attachments[0];
      const imageUrl = attachment.contentUrl;

      console.log("[App] Processing image attachment:", {
        imageUrl,
        contentType: attachment.contentType,
      });

      const base64Image = await imageService.processImage(
        imageUrl,
        tokenFactory
      );
      const textFromImage = await openaiService.analyzeImage(
        base64Image,
        "Please extract and return: 1) The exact question being asked in the form, and 2) Any error message shown. Format as: Question: [question text] Error: [error message] or marked/pointed out area in the image"
      );

      message += "\n\n" + textFromImage;
      console.log("[App] Successfully processed image and extracted text");
    } catch (imageError: any) {
      console.error("[App] Error processing image:", imageError);
      message += "\n\n[Note: Unable to process the attached image.]";
    }
  }

  // Analyze intent
  const messageIntent = await openaiService.analyzeIntent(message);
  const isMentioned = activity.entities?.some(
    (entity: any) =>
      entity.type === "mention" &&
      entity.mentioned?.id === activity.recipient?.id
  );

  if (messageIntent === "IGNORE" && !isMentioned) {
    return "";
  }

  return message;
}

export async function _callMsGraph(graphUrl: string, accessToken: string) {
  const headers = new Headers()
  const bearer = `Bearer ${accessToken}`

  headers.append('Authorization', bearer)

  const options = {
    method: 'GET',
    headers: headers,
  }

  const result: any = []

  graphUrl = `${graphUrl}?$top=999`
  while (graphUrl) {
    const response = await fetch(graphUrl, options)
    const data = await response?.json()
    result.push(...data.value)
    graphUrl = data['@odata.nextLink']
  }

  return {value: result}
}

