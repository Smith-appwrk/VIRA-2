const config = {
  MicrosoftAppId: process.env.CLIENT_ID,
  MicrosoftAppType: process.env.BOT_TYPE,
  MicrosoftAppTenantId: process.env.TENANT_ID,
  MicrosoftAppPassword: process.env.CLIENT_SECRET,
  openAIKey: process.env.OPENAI_API_KEY || process.env.SECRET_OPENAI_API_KEY,
  openAIModelName: process.env.OPENAI_MODEL || "gpt-4o-mini",
  // Bot behavior configuration
  MESSAGE_RETENTION_COUNT: parseInt(process.env.MESSAGE_RETENTION_COUNT || "20"),
  RESPONSE_DELAY_MIN: parseInt(process.env.RESPONSE_DELAY_MIN || "15000"),
  RESPONSE_DELAY_MAX: parseInt(process.env.RESPONSE_DELAY_MAX || "20000"),
  // AI Temperature Settings
  LANGUAGE_DETECTION_TEMPERATURE: parseFloat(process.env.LANGUAGE_DETECTION_TEMPERATURE || "0.3"),
  MESSAGE_INTENT_TEMPERATURE: parseFloat(process.env.MESSAGE_INTENT_TEMPERATURE || "0.5"),
  RESPONSE_TEMPERATURE: parseFloat(process.env.RESPONSE_TEMPERATURE || "0.7"),
  TRANSLATION_TEMPERATURE: parseFloat(process.env.TRANSLATION_TEMPERATURE || "0.3"),
  COMPLETION_FREQUENCY_PENALTY: parseFloat(process.env.COMPLETION_FREQUENCY_PENALTY || "0.8"),
  COMPLETION_PRESENCE_PENALTY: parseFloat(process.env.COMPLETION_PRESENCE_PENALTY || "0.3"),
  // Support Team Configuration
  SUPPORT_USERS: (process.env.SUPPORT_USERS || '').split(',').map((user: string) => {
    const [name, email] = user.split(':');
    return { name, email };
  }).filter((user: any) => user.name && user.email),
  REPLY_TO: (process.env.REPLY_TO || '').split('|').map((name: string) =>
    name.toLowerCase().replaceAll(' ', '')
  ).filter((name: string) => name.length > 0),
  // Knowledge Analysis Configuration
  KNOWLEDGE_ANALYSIS_ENABLED: process.env.KNOWLEDGE_ANALYSIS_ENABLED === 'true',
  KNOWLEDGE_REVIEW_GROUP_ID: process.env.KNOWLEDGE_REVIEW_GROUP_ID,
  MONITORED_GROUP_IDS: process.env.MONITORED_GROUP_IDS,
  DAILY_ANALYSIS_TIME: process.env.DAILY_ANALYSIS_TIME || "23:59",
  // Azure Configuration
  APPINSIGHTS_INSTRUMENTATIONKEY: process.env.APPINSIGHTS_INSTRUMENTATIONKEY,
  WEBSITE_SITE_NAME: process.env.WEBSITE_SITE_NAME,
};

export default config;
