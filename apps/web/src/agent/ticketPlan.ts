const FENCE = /^(```|~~~)/;
const PLAN_HEAD = /^## Plan[ \t]*$/;
const SECTION_HEAD = /^#{1,2}[ \t]/;

/**
 * The `## Plan` section of a ticket body, trimmed; null when there is none or it is empty. A line
 * in a fenced block never opens or closes the section.
 */
export function ticketPlan(body: string): string | null {
  const plan: string[] = [];
  let fenced = false;
  let inPlan = false;
  for (const line of body.split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced && inPlan && SECTION_HEAD.test(line)) break;
    else if (!fenced && !inPlan && PLAN_HEAD.test(line)) {
      inPlan = true;
      continue;
    }
    if (inPlan) plan.push(line);
  }
  const text = plan.join("\n").trim();
  return text === "" ? null : text;
}
