/**
 * Force a token refresh now.
 *
 *   npm run refresh
 *
 * Normally unnecessary: ask and chat refresh automatically when the access
 * token is within 2 minutes of expiry, or when NetSuite rejects it. Useful
 * for testing the refresh path, or to reset the 7-day refresh token clock
 * before a long break.
 */
import { refreshAccessToken } from "./token.js";

try {
  const data = await refreshAccessToken();
  if (!data.persisted) {
    console.log(JSON.stringify(data, null, 2));
    console.error("\nNo .env found. Copy the values above in manually.");
    process.exit(1);
  }
  console.log("Access token refreshed and written to .env");
  console.log(`  expires_in: ${data.expires_in}s`);
  if (data.refresh_token) {
    console.log("  new refresh token saved (the previous one is now invalid)");
  }
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}
