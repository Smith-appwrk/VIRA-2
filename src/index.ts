// Load environment variables FIRST, before importing any modules that use process.env
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Try multiple locations: env/.env, .env, or root .env
const envPaths = [
  path.join(__dirname, '../env/.env'),
  path.join(__dirname, '../.env'),
  path.join(process.cwd(), 'env/.env'),
  path.join(process.cwd(), '.env')
];

let envLoaded = false;
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`[Index] Loaded environment variables from: ${envPath}`);
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  console.warn('[Index] No .env file found, using system environment variables only');
}

// Now import app after environment variables are loaded
import app from "./app/app";

// Start the application
(async () => {
  await app.start(process.env.PORT || process.env.port || 3978);
  console.log(`\nAgent started, app listening to`, process.env.PORT || process.env.port || 3978);
})();
