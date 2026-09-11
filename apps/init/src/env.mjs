/**
 * Reads a variable from the environment, then from a dotenv file.
 *
 * The scaffolded service is started with `node --env-file=.env`, which is the
 * documented pattern — so on a correctly configured project the admin token is
 * in that file and not in the shell, and this tool refused to run against it
 * until someone exported by hand. Node cannot be asked to load a file after
 * start, so the file is parsed here rather than shelling out.
 *
 * Shared by `doctor` and the walk, deliberately: the first version lived in one
 * frontend only, so the same project passed `doctor` and stalled the walk —
 * the assert-in-one-mode-assume-in-the-other gap this tool exists to prevent,
 * reproduced inside the tool itself.
 */
import { readFileSync } from "node:fs";

export function readEnvVar(name, envFile) {
  if (!name) return undefined;
  if (process.env[name]) return process.env[name];
  for (const candidate of envFile ? [envFile] : [".env", ".env.local"]) {
    try {
      const line = readFileSync(candidate, "utf8")
        .split("\n")
        .find((entry) => entry.trimStart().startsWith(`${name}=`));
      if (!line) continue;
      // Strip one layer of surrounding quotes, which dotenv files commonly use.
      return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    } catch {
      continue;
    }
  }
  return undefined;
}
