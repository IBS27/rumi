const environment = process.env.VITE_APP_ENV;
const required = ["VITE_CONVEX_URL", "VITE_CLERK_PUBLISHABLE_KEY"];
if (environment !== "staging" && environment !== "production")
  throw new Error("Set VITE_APP_ENV to staging or production before building.");
for (const name of required)
  if (!process.env[name]?.trim()) throw new Error(`Missing ${name}.`);
const url = new URL(process.env.VITE_CONVEX_URL!);
if (url.protocol !== "https:" || !url.hostname.endsWith(".convex.cloud"))
  throw new Error("Expected an HTTPS Convex deployment URL.");
if (
  environment === "production" &&
  !process.env.VITE_CLERK_PUBLISHABLE_KEY!.startsWith("pk_live_")
)
  throw new Error("Production requires a live Clerk instance.");
console.info(`Frontend configuration validated for ${environment}.`);
