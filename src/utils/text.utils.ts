import * as fs from 'fs';
import * as path from 'path';

// Load instructions from file on initialization
export function loadInstructions(): string {
  const instructionPath = path.join(__dirname, 'instructions.txt');
  if (fs.existsSync(instructionPath)) {
    return fs.readFileSync(instructionPath, 'utf-8').trim();
  }
  return 'You are a helpful assistant.';
}