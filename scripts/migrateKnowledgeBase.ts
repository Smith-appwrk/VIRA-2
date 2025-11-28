/**
 * Migration script to embed existing knowledge base into Azure AI Search
 *
 * Usage:
 *   npm run migrate:kb
 *
 * Or directly:
 *   npx ts-node scripts/migrateKnowledgeBase.ts
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Load environment variables FIRST before importing CONFIG
const envPaths = [
  path.join(__dirname, "../env/.env"),
  path.join(__dirname, "../.env"),
  path.join(process.cwd(), "env/.env"),
  path.join(process.cwd(), ".env"),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`[Migration] Loaded environment variables from: ${envPath}`);
    break;
  }
}

// NOW import services after env vars are loaded
import { OpenAIService } from "../src/services/openaiService";
import {
  AzureSearchService,
  KnowledgeDocument,
} from "../src/services/azureSearchService";
import { CONFIG } from "../src/config";

async function migrateKnowledgeBase() {
  console.log(
    "[Migration] Starting knowledge base migration to Azure AI Search...\n"
  );

  // Check if Azure AI Search is configured
  if (!CONFIG.AZURE_SEARCH_ENDPOINT) {
    console.error(
      "[Migration] ERROR: Azure AI Search endpoint not configured."
    );
    console.error(
      "[Migration] Please set AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_ADMIN_KEY in your .env file."
    );
    process.exit(1);
  }

  // Initialize services
  const openaiService = new OpenAIService(CONFIG.OPENAI_API_KEY || "");
  const azureSearchService = new AzureSearchService(openaiService);

  try {
    // Initialize Azure AI Search (creates index if needed)
    console.log("[Migration] Initializing Azure AI Search...");
    await azureSearchService.initialize();
    console.log("[Migration] ✓ Azure AI Search initialized\n");

    // Load knowledge base
    const kbPath = path.join(__dirname, "../src/data/intelligate.md");
    if (!fs.existsSync(kbPath)) {
      console.error(
        `[Migration] ERROR: Knowledge base file not found: ${kbPath}`
      );
      process.exit(1);
    }

    console.log("[Migration] Loading knowledge base...");
    const kbContent = fs.readFileSync(kbPath, "utf8");
    console.log(
      `[Migration] ✓ Loaded knowledge base (${kbContent.length} characters)\n`
    );

    // Parse knowledge base into documents
    console.log("[Migration] Parsing knowledge base into documents...");
    const documents = parseKnowledgeBase(kbContent);
    console.log(`[Migration] ✓ Parsed ${documents.length} documents\n`);

    // Upload documents to Azure AI Search
    console.log("[Migration] Uploading documents to Azure AI Search...");
    console.log(
      "[Migration] This may take a few minutes depending on the size of your knowledge base...\n"
    );

    let uploaded = 0;
    const batchSize = 50; // Process in batches to avoid rate limits

    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      await azureSearchService.upsertDocuments(batch);
      uploaded += batch.length;
      console.log(
        `[Migration] Progress: ${uploaded}/${
          documents.length
        } documents uploaded (${Math.round(
          (uploaded / documents.length) * 100
        )}%)`
      );
    }

    console.log(
      `\n[Migration] ✓ Successfully uploaded ${uploaded} documents to Azure AI Search\n`
    );

    // Verify upload
    const count = await azureSearchService.getDocumentCount();
    console.log(`[Migration] Verification: ${count} documents in index\n`);

    console.log("[Migration] ✓ Migration completed successfully!");
    console.log(
      "[Migration] Your knowledge base is now searchable using semantic search.\n"
    );
  } catch (error: any) {
    console.error("[Migration] ERROR:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Parse knowledge base in Q: A: format into structured documents
 */
function parseKnowledgeBase(content: string): KnowledgeDocument[] {
  const documents: KnowledgeDocument[] = [];
  let docId = 0;

  // Split content by Q: markers to find all Q&A pairs
  // This regex matches "Q:" at the start of a line
  const qaBlocks = content.split(/\n(?=Q:\s)/);

  for (const block of qaBlocks) {
    // Skip empty blocks
    if (!block.trim() || !block.trim().startsWith("Q:")) {
      continue;
    }

    const lines = block.split("\n");

    // Extract question from first line
    const questionMatch = lines[0].match(/^Q:\s*(.+)$/);
    if (!questionMatch) {
      continue;
    }

    const question = questionMatch[1].trim();
    if (question.length < 3) {
      continue;
    }

    // Find the answer - look for "A:" marker
    let answerStartIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].match(/^A:\s*/)) {
        answerStartIndex = i;
        break;
      }
    }

    if (answerStartIndex === -1) {
      continue; // No answer found
    }

    // Extract answer - everything after "A:" until the end of the block
    const answerLines: string[] = [];

    // Handle the line with "A:" - it may have content on the same line
    const answerLine = lines[answerStartIndex];
    const answerMatch = answerLine.match(/^A:\s*(.+)$/);
    if (answerMatch && answerMatch[1].trim()) {
      answerLines.push(answerMatch[1].trim());
    }

    // Add remaining lines (answer can span multiple lines)
    for (let i = answerStartIndex + 1; i < lines.length; i++) {
      answerLines.push(lines[i]);
    }

    // Join and clean up answer
    let answer = answerLines.join("\n").trim();

    // Remove trailing empty lines
    answer = answer.replace(/\n+$/, "");

    // Only add if we have meaningful answer content
    if (answer.length > 5) {
      // Create a combined content field that includes both question and answer
      const fullContent = `Q: ${question}\nA: ${answer}`;

      documents.push({
        id: `kb_${docId++}`,
        content: fullContent,
        question: question,
        answer: answer,
        source: "intelligate.md",
        timestamp: Date.now(),
        status: "approved",
      });
    }
  }

  return documents;
}

// Run migration
if (require.main === module) {
  migrateKnowledgeBase().catch((error) => {
    console.error("[Migration] Fatal error:", error);
    process.exit(1);
  });
}

export { migrateKnowledgeBase };
