export interface ParsedCliOptions {
  args: string[];
  json: boolean;
}

export function parseCliOptions(argv: string[]): ParsedCliOptions {
  let json = false;
  const args: string[] = [];

  for (const token of argv) {
    if (token === "--json") {
      json = true;
      continue;
    }

    args.push(token);
  }

  return { args, json };
}
