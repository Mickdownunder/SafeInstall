import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-licenses");
const licenseFile = /^(licen[sc]e|copying)(?:[._-]|$)/i;

export async function createThirdPartyNotices(records, options = {}) {
  const directory = options.assetsDirectory ?? assets;
  const supplements = JSON.parse(await readFile(path.join(directory, "sources.json"), "utf8"));
  const notices = [];
  const seen = new Map();
  for (const record of [...records].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
    const key = `${record.name}@${record.version}`;
    if (seen.has(key)) {
      if (seen.get(key) !== record.license) throw new Error(`Conflicting licenses for ${key}.`);
      continue;
    }
    seen.set(key, record.license);
    const entries = await readdir(record.source, { withFileTypes: true });
    const licenses = entries.filter(entry => entry.isFile() && licenseFile.test(entry.name));
    if (licenses.length > 0) {
      for (const entry of licenses) {
        if (!(await readFile(path.join(record.source, entry.name), "utf8")).trim()) {
          throw new Error(`Empty dependency license file: ${key}/${entry.name}.`);
        }
      }
      continue; // Original files and notices are copied with the dependency.
    }
    const matching = supplements.filter(item => item.name === record.name && item.version === record.version);
    if (matching.length !== 1 || matching[0].license !== record.license) {
      throw new Error(`Missing reviewed license text for ${key} (${record.license}); update the pinned supplement before distributing.`);
    }
    const supplement = matching[0];
    if (typeof supplement.file !== "string" || path.basename(supplement.file) !== supplement.file ||
        typeof supplement.source !== "string" || !supplement.source.startsWith("https://") ||
        typeof supplement.packageSource !== "string" || !supplement.packageSource.startsWith("https://") ||
        typeof supplement.attribution !== "string" || !supplement.attribution.trim()) {
      throw new Error(`Invalid license supplement metadata for ${key}.`);
    }
    const text = (await readFile(path.join(directory, supplement.file), "utf8")).replace(/\r\n/g, "\n");
    const digest = createHash("sha256").update(text).digest("hex");
    if (!text.trim() || digest !== supplement.sha256) {
      throw new Error(`License supplement integrity mismatch for ${key}.`);
    }
    notices.push(`## ${key} — ${record.license}\n\nLicense text source: ${supplement.source}\n` +
      `Package declaration: ${supplement.packageSource}\n${supplement.attribution}\n\n${text.trimEnd()}\n`);
  }
  return "# Third-party notices\n\n" +
    "Original dependency license and notice files are retained in runtime/node_modules.\n" +
    "The following full license terms supplement published packages that omit a license file.\n" +
    "Exact upstream texts are used where available; otherwise SPDX terms and separately identified\n" +
    "published author metadata are provided without inventing a copyright owner or year.\n\n" +
    notices.join("\n---\n\n");
}
