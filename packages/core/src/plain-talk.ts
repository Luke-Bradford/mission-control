/**
 * A mechanical check of the rules in `.claude/skills/plain-talk/SKILL.md` that a program can
 * judge: a sentence under 20 words, no exclamation marks, none of the words the skill bans. It does
 * not judge order or content; it is the check a seat's report text must pass (#1051).
 */
export const PLAIN_TALK_SENTENCE_MAX = 20;

/** Words and phrases the skill's rule 4 and word table rule out. */
const BANNED = [
  /\bi think\b/i,
  /\bit seems\b/i,
  /\bunfortunately\b/i,
  /\bgreat news\b/i,
  /\bjust\b/i,
  /\bsimply\b/i,
  /\beasy\b/i,
  /\bquick(ly)?\b/i,
  /\bterminate\b/i,
  /\benable\b/i,
  /\bescalate\b/i,
];

/** What is wrong with `text`, one line each; empty when it passes. */
export function plainTalkProblems(text: string): string[] {
  const problems: string[] = [];
  if (text.includes("!")) problems.push("has an exclamation mark");
  for (const re of BANNED) {
    const hit = re.exec(text);
    if (hit !== null) problems.push(`uses "${hit[0]}"`);
  }
  const prose = text.replace(/`[^`]*`/g, "code");
  for (const sentence of prose.split(/(?<=[.?!:])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean).length;
    if (words >= PLAIN_TALK_SENTENCE_MAX) {
      problems.push(`has a sentence of ${words} words: "${sentence.trim().slice(0, 40)}…"`);
    }
  }
  return problems;
}
