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
export function gitClone(url: string, target: string, token?: string, username = "x-access-token"): Promise<boolean> {
  // A clone of a big repository can rightly take a long time, so there's no overall timeout;
  // instead git gives up when the transfer stalls below 1 KB/s for a minute.
  const stall = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"];
  if (!token) return runVisibly("git", [...stall, "clone", url, target]);

  // An inline credential helper reads the token from the environment, so it never appears
  // in the command line or in the clone's saved config. GitHub expects the username
  // x-access-token; GitLab expects oauth2.
  const host = new URL(url);
  if (host.protocol !== "https:" || host.username || host.password) throw new Error("Authenticated clones require an HTTPS URL without embedded credentials.");
  const helper = '!f() { while IFS= read -r line; do case "$line" in host=*) requested=${line#host=};; esac; done; [ "$requested" = "$DEV_CLONE_HOST" ] || exit 1; echo "username=$DEV_CLONE_USER"; echo "password=$DEV_CLONE_TOKEN"; }; f';
  return runVisibly("git", [...stall, "-c", "credential.helper=", "-c", `credential.helper=${helper}`, "clone", url, target], {
    env: { ...process.env, DEV_CLONE_TOKEN: token, DEV_CLONE_USER: username, DEV_CLONE_HOST: host.host, GIT_TERMINAL_PROMPT: "0" },
  });
}
