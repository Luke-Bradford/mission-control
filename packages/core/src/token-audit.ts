/** What was added to the context since the previous call, from one source. */
export interface TokenSourceAdd {
  /** A tool name, or one of the `TOKEN_SOURCE_*` names. */
  source: string;
  /** Bash only: the command's first word, or `pnpm <script>`. */
  command: string | null;
  tokens: number;
}

/** One model call of a run. */
export interface TokenCall {
  /** When the call's first frame was written (ms); null when the transcript carried no time. */
  at?: number | null;
  /** Context size: input + cache read + cache write. */
  context: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  added: TokenSourceAdd[];
}
