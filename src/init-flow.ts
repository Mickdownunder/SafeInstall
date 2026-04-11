import { writeFile } from "node:fs/promises";

import { createDefaultConfig, getConfigPath, serializeConfig } from "./config";
import { formatCommand } from "./output";
import { fileExists } from "./project-discovery";
import type { CliResult } from "./types";

export interface InitOptions {
  force: boolean;
}

export async function runInitFlow(cwd: string, argv: string[], options: InitOptions): Promise<CliResult> {
  const configPath = getConfigPath(cwd);
  const alreadyExists = await fileExists(configPath);

  if (alreadyExists && !options.force) {
    return {
      mode: "init",
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "SafeInstall could not create the config file.",
      command: argv,
      commandString: formatCommand("safeinstall", argv),
      reasons: [
        {
          code: "config-exists",
          message: `Config already exists at ${configPath}.`,
          suggestion: "Re-run with --force to overwrite it intentionally."
        }
      ],
      summary: "Init failed: config already exists.",
      warnings: [],
      affectedPackages: [],
      details: {
        configPath,
        overwritten: false
      }
    };
  }

  const config = createDefaultConfig();
  await writeFile(configPath, serializeConfig(config), "utf8");

  return {
    mode: "init",
    decision: "allow",
    exitCode: 0,
    exitCodeMeaning: "Config created successfully.",
    command: argv,
    commandString: formatCommand("safeinstall", argv),
    reasons: [],
    summary: alreadyExists ? "Starter config overwritten." : "Starter config created.",
    warnings: [
      "Edit allowedScripts, allowedSources, or allowedPackages only when you intend to trust that exception."
    ],
    affectedPackages: [],
    details: {
      configPath,
      overwritten: alreadyExists
    }
  };
}
