/**
 * A mechanical check of the rules in `.claude/skills/plain-talk/SKILL.md` that a program can
 * judge: a sentence under 20 words, no exclamation marks, none of the words the skill bans. It does
 * not judge order or content; it is the check a seat's report text must pass (#1051).
 */
export const PLAIN_TALK_SENTENCE_MAX = 20;

/** A verb and its inflected forms: `forms("terminate")` matches terminate, terminates, terminated, terminating. */
const forms = (verb: string): RegExp => {
  const stem = verb.endsWith("e") ? verb.slice(0, -1) : verb;
  return new RegExp(`\\b(${verb}s?|${stem}(ed|ing)|${verb}d)\\b`, "i");
};

/**
 * Words and phrases the skill's rule 4, word table and "words" list rule out. The table's "may"
 * (for "possibly") depends on meaning, so it is not checked here.
 */
const BANNED = [
  /\bi think\b/i,
  /\bit seems\b/i,
  /\bunfortunately\b/i,
  /\bgreat news\b/i,
  /\bjust\b/i,
  /\bsimply\b/i,
  /\beasy\b/i,
  /\bquick(ly)?\b/i,
  /\bin order to\b/i,
  /\ballow(s|ed|ing)? you to\b/i,
  // the table's heavy verbs: stop/end/cancel, ask/tell, turn on/off
  ...["kill", "abort", "terminate", "escalate", "surface", "flag", "enable", "disable"].map(forms),
  // "Name yourself by your seat name, not I"
  /\bI(?:'m|'ve|'ll|'d)?\b/,
];

/** What is wrong with `text`, one line each; empty when it passes. */
export function plainTalkProblems(text: string): string[] {
  const problems: string[] = [];
  const prose = text.replace(/`[^`]*`/g, "code");
  if (text.includes("!")) problems.push("has an exclamation mark");
  for (const re of BANNED) {
    const hit = re.exec(prose);
    if (hit !== null) problems.push(`uses "${hit[0]}"`);
  }
  for (const sentence of prose.split(/(?<=[.?!:])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/).filter(Boolean).length;
    if (words >= PLAIN_TALK_SENTENCE_MAX) {
      problems.push(`has a sentence of ${words} words: "${sentence.trim().slice(0, 40)}…"`);
    }
  }
  return problems;
}
