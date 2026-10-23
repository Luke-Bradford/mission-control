/** `launchctl print` output with a secret in the job's environment; only the top-level tab-indented lines count. */
const block = (state: string, pid: string): string =>
  [
    "gui/501/x = {",
    "\ttype = LaunchAgent",
    `\tstate = ${state}`,
    "\tenvironment = {",
    "\t\tSECRET_X => leak-me",
    "\t}",
    "\tendpoints = {",
    "\t\tstate = waiting",
    "\t\tpid = 1",
    "\t}",
    ...(pid === "" ? [] : [`\tpid = ${pid}`]),
    "}",
    "",
  ].join("\n");

export const PRINT_RUNNING = block("running", "4242");
export const PRINT_NOT_RUNNING = block("not running", "");
