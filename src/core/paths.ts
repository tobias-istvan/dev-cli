import { homedir } from "node:os";
import path from "node:path";

/** The per-person folder, outside every workspace. Honours XDG_CONFIG_HOME. */
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  return path.join(base, "dev");
}

/** Where the package's own files are, like templates/. Same depth from src/ and dist/. */
export function packageDir(): string {
  return path.join(import.meta.dirname, "..", "..");
}
