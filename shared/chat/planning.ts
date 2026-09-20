import type { ProjectPhase } from "../contracts";

const DIRECT_REPLAN =
  /\b(?:start|restart|retry|redo|try)\s+(?:the\s+)?(?:space\s+)?planning\b/i;
const SHORT_ASSENT = /^(?:ok(?:ay)?|yes|sure|do it|try again|please do|(?:no[,\s]+)?go for it)[.!\s]*$/i;
// Never force planning ahead of updateBrief or an explicit stop. A preference
// change can mention "bed"/"room" too; those words alone are not retry consent.
const BRIEF_CHANGE = /\b(?:no|not|don't|dont|without|exclude|skip|stop|cancel|never mind|instead|only|remove|add|want|need)\b/i;
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
  if (!SHORT_ASSENT.test(latestUser.trim()) && BRIEF_CHANGE.test(latestUser))
    return false;
  if (DIRECT_REPLAN.test(latestUser)) return true;
  if (!FAILED_PLAN.test(previousAssistant)) return false;
  return (
    SHORT_ASSENT.test(latestUser.trim()) ||
    PLACEMENT_ADJUSTMENT.test(latestUser)
  );
}
