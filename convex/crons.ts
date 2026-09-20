import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval(
  "remove abandoned scan uploads",
  { hours: 24 },
  internal.captures.sweepPackages,
  {},
);
export default crons;
