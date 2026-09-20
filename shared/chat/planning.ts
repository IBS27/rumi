import type { ProjectPhase } from "../contracts";

const DIRECT_REPLAN =
  /\b(?:start|restart|retry|redo|try)\s+(?:the\s+)?(?:space\s+)?planning\b/i;
const SHORT_ASSENT = /^(?:ok(?:ay)?|yes|sure|do it|try again|please do)[.!\s]*$/i;
const PLACEMENT_ADJUSTMENT =
  /\b(?:bed|fit|fits|closer|close|smaller|position|orientation|space|room|shelf|storage)\b/i;
const FAILED_PLAN =
  /\b(?:could not|couldn't|cannot|can't|failed|doesn't fit|did not fit|space constraints|retry|try again|smaller bed|different placement)\b/i;

// Once a plan has failed, an explicit retry or an answer to the proposed
// adjustment is an action, not another design question. The caller uses this
// to require planSpace on the first model step.
export function shouldForcePlanSpace(
  phase: ProjectPhase,
  latestUser: string,
  previousAssistant: string,
): boolean {
  if (phase !== "plan") return false;
  if (DIRECT_REPLAN.test(latestUser)) return true;
  if (!FAILED_PLAN.test(previousAssistant)) return false;
  return (
    SHORT_ASSENT.test(latestUser.trim()) ||
    PLACEMENT_ADJUSTMENT.test(latestUser)
  );
}
