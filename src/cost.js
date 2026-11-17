/**
 * Dollar cost of a request from its token usage, at Anthropic list prices.
 * An estimate for budgets and the review, not an invoice. Update the table
 * when the model or the price list changes.
 */
export const PRICES = {
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};

export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";

export const priceFor = (model = MODEL) => PRICES[model] || PRICES["claude-sonnet-5-5"];

/**
 * `usage` in the API's shape ({input_tokens, output_tokens, ...}) or the
 * log's ({in, out}). Cache reads bill at a tenth of the input price and
 * cache writes at 1.25x, so a future prompt cache is already counted right.
 */
export function costOf(usage, model = MODEL) {
  if (!usage) return 0;
  const p = priceFor(model);
  const input = usage.input_tokens ?? usage.in ?? 0;
  const output = usage.output_tokens ?? usage.out ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (input * p.in + output * p.out + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25) / 1e6;
}
