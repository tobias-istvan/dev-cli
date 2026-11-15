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

/** The service has no such item: deleted, moved, or hidden from this login. */
export class NotFound extends DevError {
  constructor(message: string, fix?: string) {
    super(message, fix);
    this.name = "NotFound";
  }
}

/** A fetch refused because the item is outside the scope, and the workspace only fetches within it. */
export class OutsideScope extends DevError {
  constructor(what: string, hint = 'To allow it, set "fetch: anywhere" for that service in dev.yaml.') {
    super(`${what} is outside this workspace's scope, so it wasn't fetched.`, hint);
    this.name = "OutsideScope";
  }
}

export const consoleOutput: Output = {
  info: (message) => console.log(message),
  warn: (message) => console.error(message),
  progress: (message) => console.error(message),
};

export function formatProblems(problems: Problem[]): string {
  return problems
    .map((problem) => `- ${problem.message}${problem.fix ? `\n  Fix: ${problem.fix}` : ""}`)
    .join("\n");
}

/** An error's message with its fix, for lists of failures where both should show. */
export function describeError(error: unknown): string {
  const message = (error as Error).message ?? String(error);
  const fix = error instanceof DevError ? error.fix : undefined;
  return fix ? `${message} ${fix}` : message;
}
