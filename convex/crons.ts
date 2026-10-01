import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.daily(
  "remove interrupted file uploads",
  { hourUTC: 4, minuteUTC: 0 },
  internal.storageCleanup.sweep,
  {},
);
crons.hourly(
  "expire merchant cache",
  { minuteUTC: 10 },
  internal.sourceCache.expire,
  {},
);
export default crons;
