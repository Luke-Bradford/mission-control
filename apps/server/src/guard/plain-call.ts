/** A command that chains, pipes, or runs on after a failure can pass without the check passing. */
export const NOT_PLAIN = /[|;\n\r]/;

/** A command with no pipe, `||`, `;` or line break: its exit status is its last step's own. */
export const plainCall = (command: string): boolean => !NOT_PLAIN.test(command);
