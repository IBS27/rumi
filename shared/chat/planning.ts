import type { ProjectPhase } from "../contracts";

const DIRECT_REPLAN =
  /^(?:please\s+)?(?:start|restart|retry|redo|try)\s+(?:the\s+)?(?:space\s+)?planning(?:[.!\s]+now)?[.!\s]*$/i;
const SHORT_ASSENT = /^(?:ok(?:ay)?|yes|sure|do it|try again|please do|(?:no[,\s]+)?go for it)[.!\s]*$/i;
// Never force planning ahead of updateBrief or an explicit stop. A preference
// change can mention "bed"/"room" too; those words alone are not retry consent.
const BRIEF_CHANGE = /\b(?:no|not|don't|dont|without|exclude|skip|stop|cancel|never mind|instead|only|remove|add|want|need)\b/i;
const RETRY_ADJUSTMENT =
  /^(?:please\s+)?try\s+(?:(?:with|using)\s+)?(?:a\s+)?(?:smaller\s+(?:bed|footprint)|different\s+(?:placement|orientation|anchor))[.!\s]*$/i;
const FAILED_PLAN =
  /\b(?:could not|couldn't|cannot|can't|failed|doesn't fit|did not fit|space constraints|retry|try again|smaller bed|different placement)\b/i;

// Only explicit retries and approval of a failed plan's adjustment bypass
// normal tool selection. Questions, edits, and new placement facts still need
// the agent to decide whether to answer, edit the room, or update the brief.
export function shouldForcePlanSpace(
  phase: ProjectPhase,
  latestUser: string,
  previousAssistant: string,
): boolean {
  if (phase !== "plan") return false;
  const message = latestUser.trim();
  if (!SHORT_ASSENT.test(message) && BRIEF_CHANGE.test(message))
    return false;
  if (DIRECT_REPLAN.test(message)) return true;
  if (!FAILED_PLAN.test(previousAssistant)) return false;
  return (
    SHORT_ASSENT.test(message) ||
    RETRY_ADJUSTMENT.test(message)
  );
}
