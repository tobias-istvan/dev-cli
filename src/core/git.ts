import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Runs git and returns its trimmed output. Throws with git's own message on failure. */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  } catch (error) {
    const stderr = ((error as { stderr?: string }).stderr ?? "").trim();
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr.split("\n").at(-1)}` : ""}`);
  }
}

/** Like git(), but returns null instead of throwing, for questions with a yes-or-no answer. */
export async function gitMaybe(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}
