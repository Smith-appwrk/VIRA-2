const SUPPORT_USERS = (process.env.SUPPORT_USERS || "")
  .split(",")
  .map((user) => {
    const [name, email] = user.split(":");
    return { name, email };
  })
  .filter((user) => user.name && user.email);

const REPLY_TO = (process.env.REPLY_TO || "")
  .split("|")
  .map((name) => name.toLowerCase().replaceAll(" ", ""))
  .filter((name) => name.length > 0);

const KB_REVIEW_USERS = (process.env.KB_REVIEW_USERS || "")
  .split("|")
  .map((name) => name.toLowerCase().replaceAll(" ", ""))
  .filter((name) => name.length > 0);

export const CONFIG = {
  MicrosoftAppId: process.env.CLIENT_ID,
  MicrosoftAppType: process.env.BOT_TYPE,
  MicrosoftAppTenantId: process.env.TENANT_ID,
  MicrosoftAppPassword: process.env.CLIENT_SECRET,
  MESSAGE_RETENTION_COUNT: parseInt(
    process.env.MESSAGE_RETENTION_COUNT || "20"
  ),
  RESPONSE_DELAY_MIN: parseInt(process.env.RESPONSE_DELAY_MIN || "15000"),
  RESPONSE_DELAY_MAX: parseInt(process.env.RESPONSE_DELAY_MAX || "20000"),
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",
  LANGUAGE_DETECTION_TEMPERATURE: parseFloat(
    process.env.LANGUAGE_DETECTION_TEMPERATURE || "0.3"
  ),
  MESSAGE_INTENT_TEMPERATURE: parseFloat(
    process.env.MESSAGE_INTENT_TEMPERATURE || "0.5"
  ),
  RESPONSE_TEMPERATURE: parseFloat(process.env.RESPONSE_TEMPERATURE || "0.1"),
  TRANSLATION_TEMPERATURE: parseFloat(
    process.env.TRANSLATION_TEMPERATURE || "0.3"
  ),
  COMPLETION_FREQUENCY_PENALTY: parseFloat(
    process.env.COMPLETION_FREQUENCY_PENALTY || "0.8"
  ),
  COMPLETION_PRESENCE_PENALTY: parseFloat(
    process.env.COMPLETION_PRESENCE_PENALTY || "0.3"
  ),
  OPENAI_API_KEY:
    process.env.SECRET_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  SUPPORT_USERS,
  REPLY_TO,
  KB_REVIEW_USERS,
  KNOWLEDGE_ANALYSIS_ENABLED: true,
  KNOWLEDGE_REVIEW_GROUP_ID:
    process.env.KNOWLEDGE_REVIEW_GROUP_ID ||
    "19:94e839e49810435bb48afaa069113a93@thread.v2",
  DAILY_ANALYSIS_TIME: process.env.DAILY_ANALYSIS_TIME || "13:42",
  // Azure AI Search Configuration
  AZURE_SEARCH_ENDPOINT: process.env.AZURE_SEARCH_ENDPOINT || "",
  AZURE_SEARCH_ADMIN_KEY: process.env.AZURE_SEARCH_ADMIN_KEY || "",
  AZURE_SEARCH_QUERY_KEY:
    process.env.AZURE_SEARCH_QUERY_KEY ||
    process.env.AZURE_SEARCH_ADMIN_KEY ||
    "",
  AZURE_SEARCH_INDEX_NAME:
    process.env.AZURE_SEARCH_INDEX_NAME || "intelligate-kb",
  AZURE_SEARCH_USE_MANAGED_IDENTITY:
    process.env.AZURE_SEARCH_USE_MANAGED_IDENTITY === "true",
  // OpenAI Embedding Configuration
  OPENAI_EMBEDDING_MODEL:
    process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  OPENAI_EMBEDDING_DIMENSIONS: parseInt(
    process.env.OPENAI_EMBEDDING_DIMENSIONS || "1536"
  ),
  // SQL Server Database Configuration
  WRITABLE_DB_HOST: process.env.WRITABLE_DB_HOST || "",
  WRITABLE_DB_NAME: process.env.WRITABLE_DB_NAME || "",
  WRITABLE_DB_USERNAME: process.env.WRITABLE_DB_USERNAME || "",
  WRITABLE_DB_PASSWORD: process.env.WRITABLE_DB_PASSWORD || "",
};
