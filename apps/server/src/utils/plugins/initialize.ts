import { copyFile, cp, mkdir, readFile, readdir, rename, unlink, writeAtomic, writeFile } from "@toonflow/file";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** 单个内置插件的升级记录：用于区分“未改官方文件”“已是最新”“用户定制”。 */
type PluginFileRecord = {
  /** 上次已知官方版本的内容哈希（升级基线）。缺失表示旧版本没有可信清单。 */
  officialHash?: string;
  /** 上次同步后目标文件的内容哈希。 */
  installedHash?: string;
  status: "installed" | "unchanged" | "updated" | "customized";
  /** 定制保留时，新官方产物所在的非自动加载位置（相对目标目录）。 */
  pendingPath?: string;
  detectedAt?: string;
};

type PluginManifest = {
  revision?: string;
  updatedAt: string;
  files: Record<string, PluginFileRecord>;
};

export type { PluginManifest };

async function readManifest(path: string): Promise<PluginManifest> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return { updatedAt: new Date().toISOString(), files: {} };
  try {
    const parsed = JSON.parse(text) as Partial<PluginManifest> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.files || typeof parsed.files !== "object") return { updatedAt: new Date().toISOString(), files: {} };
    return {
      revision: typeof parsed.revision === "string" ? parsed.revision : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      files: parsed.files,
    };
  } catch {
    // ACT: 清单损坏不阻断插件加载；按“旧基线不可信”保守迁移，保留现有文件与定制。
    return { updatedAt: new Date().toISOString(), files: {} };
  }
}

async function hashFile(path: string): Promise<string | null> {
  const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (bytes === null) return null;
  return createHash("sha256").update(bytes).digest("hex");
}

// ACT: 单文件原子替换；同目录 rename 保证读到的要么是旧版要么是新版，不出现半写文件。
async function installFile(source: string, target: string) {
  const temporary = `${target}.sync${crypto.randomUUID()}`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") console.warn(`插件同步临时文件清理失败：${temporary}`, cleanupError);
    });
    throw error;
  }
}

/**
 * 内置插件安装/升级（I3 / 契约 v3 §F.3）：
 * - 首次安装（无 revision）：只补齐缺失目录/文件，不覆盖任何现有内容。
 * - 版本同步：逐文件比较“当前 / 上次官方基线 / 新官方”三级哈希：
 *   未改动的官方文件自动更新；已是新版本直接登记；用户定制或旧基线不可信时保留当前文件，
 *   把新官方产物放到 `<目标目录>/pendingUpdates/`（非自动加载位置）并在清单中登记，等待人工合并。
 * - 不清空数据目录、不删除 initialized 标记；清单与标记均为原子写。
 */
export default async function initializePlugins(targetDirectory: string, sourceDirectory: string, fileFilter?: RegExp | readonly string[], revision?: string): Promise<PluginManifest | undefined> {
  const marker = resolve(targetDirectory, "initialized");
  const initialized = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (initialized !== null && (revision === undefined || initialized === revision)) return;

  const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entries) return;
  await mkdir(targetDirectory, { recursive: true });
  const files = entries.filter(file => fileFilter
    ? file.isFile() && (fileFilter instanceof RegExp ? fileFilter.test(file.name) : fileFilter.includes(file.name))
    : file.isDirectory());
  if (!files.length && revision === undefined) return;

  // 首次安装：只补齐缺失文件，不覆盖用户内容。
  if (revision === undefined) {
    for (const file of files) {
      await cp(resolve(sourceDirectory, file.name), resolve(targetDirectory, file.name), { recursive: true, force: false });
    }
    await writeFile(marker, "", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return;
  }

  const manifestPath = resolve(targetDirectory, "manifest.json");
  const manifest = await readManifest(manifestPath);
  const pendingDirectory = resolve(targetDirectory, "pendingUpdates");
  const next: PluginManifest = { revision, updatedAt: new Date().toISOString(), files: { ...manifest.files } };
  let pendingCount = 0;
  for (const file of files) {
    const source = resolve(sourceDirectory, file.name);
    const target = resolve(targetDirectory, file.name);
    const official = await hashFile(source);
    if (official === null) continue;
    const current = await hashFile(target);
    const known = manifest.files[file.name];
    if (current === null) {
      await installFile(source, target);
      next.files[file.name] = { officialHash: official, installedHash: official, status: "installed" };
      continue;
    }
    if (current === official) {
      next.files[file.name] = { officialHash: official, installedHash: current, status: "unchanged" };
      continue;
    }
    if (known?.officialHash !== undefined && known.officialHash === current) {
      // 未改动的官方文件：安全升级。
      await installFile(source, target);
      next.files[file.name] = { officialHash: official, installedHash: official, status: "updated" };
      continue;
    }
    // 用户定制或旧基线不可信：保留当前文件，新官方产物放非自动加载的待更新位置。
    await mkdir(pendingDirectory, { recursive: true });
    await installFile(source, resolve(pendingDirectory, file.name));
    next.files[file.name] = {
      ...(known?.officialHash === undefined ? {} : { officialHash: known.officialHash }),
      installedHash: current,
      status: "customized",
      pendingPath: `pendingUpdates/${file.name}`,
      detectedAt: new Date().toISOString(),
    };
    pendingCount += 1;
  }
  if (pendingCount) console.warn(`插件同步：${pendingCount} 个同名定制文件已保留，新官方产物写入 ${pendingDirectory}`);
  await writeAtomic(manifestPath, JSON.stringify(next, null, 2), { mode: 0o666 });
  // 同一构建只同步一次；安装器移除标记以支持同版本重装，构建变化支持升级和降级。
  await writeAtomic(marker, revision, { mode: 0o666 });
  return next;
}
