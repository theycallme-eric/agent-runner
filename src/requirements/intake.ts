import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { SourceManifest } from "./types.js";

const execFileAsync = promisify(execFile);
const IGNORED_NAMES = new Set([".git", ".DS_Store", "__MACOSX", "node_modules", "dist", "build", ".next"]);
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 50_000_000;
const MAX_TOTAL_BYTES = 500_000_000;

interface IntakeOptions {
  now?: Date;
  unzipExecutable?: string;
}

interface Budget {
  files: number;
  bytes: number;
}

export async function intakeSources(
  sourcePaths: string[],
  workspacePath: string,
  options: IntakeOptions = {},
): Promise<SourceManifest> {
  if (sourcePaths.length === 0) {
    throw new Error("At least one design source is required");
  }
  const sourcesRoot = join(workspacePath, "sources");
  await mkdir(sourcesRoot, { recursive: true });
  const inputs: SourceManifest["inputs"] = [];
  const budget: Budget = { files: 0, bytes: 0 };

  for (const [index, rawPath] of sourcePaths.entries()) {
    const sourcePath = resolve(rawPath);
    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Design source cannot be a symbolic link: ${sourcePath}`);
    }
    const name = safeName(basename(sourcePath));
    const prefix = `source-${String(index + 1).padStart(2, "0")}`;
    if (sourceStat.isDirectory()) {
      const storedPath = `sources/${prefix}-${name}`;
      await copyTree(sourcePath, join(workspacePath, storedPath), budget);
      inputs.push({ name, kind: "directory", storedPath });
      continue;
    }
    if (!sourceStat.isFile()) {
      throw new Error(`Design source must be a file, directory, or ZIP archive: ${sourcePath}`);
    }
    if (sourcePath.toLowerCase().endsWith(".zip")) {
      const storedPath = `sources/${prefix}-${safeName(name.replace(/\.zip$/i, ""))}`;
      await extractZipSafely(
        sourcePath,
        join(workspacePath, storedPath),
        budget,
        options.unzipExecutable ?? "unzip",
      );
      inputs.push({ name, kind: "zip", storedPath });
      continue;
    }
    consumeBudget(sourceStat.size, budget, sourcePath);
    const storedPath = `sources/${prefix}-${name}`;
    await copyFile(sourcePath, join(workspacePath, storedPath));
    inputs.push({ name, kind: "file", storedPath });
  }

  const manifest: SourceManifest = {
    version: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    inputs,
    files: await inventoryFiles(sourcesRoot, workspacePath),
  };
  if (manifest.files.length === 0) {
    throw new Error("Design sources do not contain any supported files");
  }
  await writeFile(
    join(workspacePath, "SOURCE_MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export async function verifySourcesUnchanged(
  workspacePath: string,
  manifest: SourceManifest,
): Promise<void> {
  const current = await inventoryFiles(join(workspacePath, "sources"), workspacePath);
  if (JSON.stringify(current) !== JSON.stringify(manifest.files)) {
    throw new Error("Requirements worker changed the copied design sources");
  }
}

async function extractZipSafely(
  archivePath: string,
  destination: string,
  budget: Budget,
  unzipExecutable: string,
): Promise<void> {
  const listing = await execFileAsync(unzipExecutable, ["-Z1", archivePath], {
    encoding: "utf8",
    maxBuffer: 10_000_000,
  });
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`ZIP archive is empty: ${archivePath}`);
  }
  for (const entry of entries) {
    const parts = entry.split("/");
    if (
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.includes("\0") ||
      parts.includes("..")
    ) {
      throw new Error(`ZIP archive contains an unsafe path: ${entry}`);
    }
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "requirements-builder-zip-"));
  try {
    await execFileAsync(unzipExecutable, ["-qq", archivePath, "-d", temporaryRoot], {
      encoding: "utf8",
      maxBuffer: 10_000_000,
    });
    await copyTree(temporaryRoot, destination, budget);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function copyTree(source: string, destination: string, budget: Budget): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Design source contains a symbolic link: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath, budget);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Design source contains an unsupported filesystem entry: ${sourcePath}`);
    }
    const fileStat = await lstat(sourcePath);
    consumeBudget(fileStat.size, budget, sourcePath);
    await copyFile(sourcePath, destinationPath);
  }
}

async function inventoryFiles(root: string, workspacePath: string): Promise<SourceManifest["files"]> {
  const files: SourceManifest["files"] = [];
  await walk(root, async (path) => {
    const content = await readFile(path);
    files.push({
      path: relative(workspacePath, path).split(sep).join("/"),
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Copied design source contains a symbolic link: ${path}`);
    }
    if (entry.isDirectory()) {
      await walk(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    } else {
      throw new Error(`Copied design source contains an unsupported filesystem entry: ${path}`);
    }
  }
}

function consumeBudget(size: number, budget: Budget, path: string): void {
  if (size > MAX_FILE_BYTES) {
    throw new Error(`Design source file exceeds 50 MB: ${path}`);
  }
  budget.files += 1;
  budget.bytes += size;
  if (budget.files > MAX_FILES) {
    throw new Error(`Design sources exceed ${MAX_FILES} files`);
  }
  if (budget.bytes > MAX_TOTAL_BYTES) {
    throw new Error("Design sources exceed 500 MB total");
  }
}

function safeName(value: string): string {
  const result = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return result || "design";
}
