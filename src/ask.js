/**
 * Stage 1: ask one question, print the answer and the tool trace.
 *
 *   npm run ask -- "How many subsidiaries do we have?"
 *   node src/ask.js "How many subsidiaries do we have?"
 */
import { loadSystemPrompt } from "./prompt.js";
import { askClaude, printResponse, explainError } from "./claude.js";

const question = process.argv.slice(2).join(" ").trim();

if (!question) {
  console.error('Usage: npm run ask -- "your question"');
  process.exit(1);
}

try {
  const res = await askClaude({
    system: loadSystemPrompt(),
    messages: [{ role: "user", content: question }],
  });
  printResponse(res);
} catch (err) {
  explainError(err);
  process.exit(1);
}
