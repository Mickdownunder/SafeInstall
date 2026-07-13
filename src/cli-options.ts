export interface ParsedCliOptions {
  args: string[];
  json: boolean;
  configPath?: string | undefined;
}

export function parseCliOptions(argv: string[]): ParsedCliOptions {
  let json = false;
  let configPath: string | undefined;
  const args: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--config") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--config requires a file path argument.");
      }
      configPath = value;
      index += 1;
      continue;
    }

    if (token.startsWith("--config=")) {
      const value = token.slice("--config=".length);
      if (!value) {
        throw new Error("--config requires a file path argument.");
      }
      configPath = value;
      continue;
    }

    args.push(token);
  }

  return { args, json, configPath };
}
