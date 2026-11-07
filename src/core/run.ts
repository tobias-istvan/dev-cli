import { spawn } from "node:child_process";

/** Runs a program with the terminal attached, so slow work like a clone shows its progress. */
export function runVisibly(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Clones with git, giving it a token only for this one command, through the environment. */
export function gitClone(url: string, target: string, token?: string): Promise<boolean> {
  if (!token) return runVisibly("git", ["clone", url, target]);

  // An inline credential helper reads the token from the environment, so it never appears
  // in the command line or in the clone's saved config.
  const helper = '!f() { echo username=x-access-token; echo "password=$DEV_CLONE_TOKEN"; }; f';
  return runVisibly("git", ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "clone", url, target], {
    env: { ...process.env, DEV_CLONE_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
  });
}
