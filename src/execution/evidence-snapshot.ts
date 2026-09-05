import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface EvidenceSnapshot {
  rootPath: string;
  sha256: string;
}

export async function stageEvidenceSnapshot(
  evidenceRootPath: string,
  sourceRefs: readonly string[],
  workspacePath: string,
): Promise<EvidenceSnapshot> {
  const root = await realpath(evidenceRootPath);
  const sources = await realpath(join(root, "sources"));
  assertWithin(root, sources, "Approved evidence sources");
  for (const sourceRef of sourceRefs) {
    const source = await realpath(resolve(root, sourceRef));
    assertWithin(sources, source, `Approved evidence reference ${sourceRef}`);
    if (!(await lstat(source)).isFile()) {
      throw new Error(`Approved evidence reference is not a file: ${sourceRef}`);
    }
  }

  const snapshotRoot = join(dirname(workspacePath), ".evidence", basename(workspacePath));
  await mkdir(dirname(snapshotRoot), { recursive: true });
  await mkdir(snapshotRoot, { recursive: false });
  await cp(sources, join(snapshotRoot, "sources"), {
    recursive: true,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  const sha256 = await hashTree(snapshotRoot);
  await makeReadOnly(snapshotRoot);
  if (await hashTree(snapshotRoot) !== sha256) {
    throw new Error("Approved evidence snapshot changed while it was being prepared");
  }
  return { rootPath: snapshotRoot, sha256 };
}

export async function evidenceSnapshotUnchanged(snapshot: EvidenceSnapshot): Promise<boolean> {
  return await hashTree(snapshot.rootPath) === snapshot.sha256;
}

async function hashTree(rootPath: string): Promise<string> {
  const entries: Array<{ path: string; sha256: string; size: number }> = [];
  await visit(rootPath, rootPath, entries);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function visit(
  rootPath: string,
  path: string,
  entries: Array<{ path: string; sha256: string; size: number }>,
): Promise<void> {
  for (const entry of (await readdir(path, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Approved evidence snapshot contains a symbolic link: ${relative(rootPath, child)}`);
    }
    if (entry.isDirectory()) {
      await visit(rootPath, child, entries);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Approved evidence snapshot contains an unsupported entry: ${relative(rootPath, child)}`);
    }
    const contents = await readFile(child);
    entries.push({
      path: relative(rootPath, child),
      sha256: createHash("sha256").update(contents).digest("hex"),
      size: contents.length,
    });
  }
}

async function makeReadOnly(path: string): Promise<void> {
  const children = await readdir(path, { withFileTypes: true });
  for (const child of children) {
    const childPath = join(path, child.name);
    if (child.isDirectory()) {
      await makeReadOnly(childPath);
      continue;
    }
    await chmod(childPath, 0o444);
  }
  await chmod(path, 0o555);
}

function assertWithin(rootPath: string, path: string, label: string): void {
  const relation = relative(rootPath, path);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`${label} must remain inside the approved evidence root`);
  }
}
