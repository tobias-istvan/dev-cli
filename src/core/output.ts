import type { Output, Problem } from "../plugins/types.ts";

/** An error a person can act on. The CLI prints the message and the fix, never a stack. */
export class DevError extends Error {
  fix: string | undefined;

  constructor(message: string, fix?: string) {
    super(message);
    this.name = "DevError";
    this.fix = fix;
  }
}

export const consoleOutput: Output = {
  info: (message) => console.log(message),
  warn: (message) => console.error(message),
};

export function formatProblems(problems: Problem[]): string {
  return problems
    .map((problem) => `- ${problem.message}${problem.fix ? `\n  Fix: ${problem.fix}` : ""}`)
    .join("\n");
}
