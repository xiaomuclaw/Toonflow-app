import { Router } from "express";
import { readFile } from "@toonflow/file";
import { createHash } from "node:crypto";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { beginFileRegistrationProtection, findFileRelocationWriteBlock, isFileCleanedByCleanup } from "@/utils/fileRecords";

const router = Router();

// ACT: 只登记显式声明来源的写入；缺省不登记，未登记文件永不参与自动清理（安全侧）。
const fileKinds = {
  generatedText: ["generated", "text"],
  generatedImage: ["generated", "image"],
  generatedVideo: ["generated", "video"],
  original: ["original", "unknown"],
} as const;

export default router.put("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096), exclusive: z.enum(["true", "false"]).optional(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), encoding: z.enum(["utf-8", "utf-8-bom", "utf-16le", "utf-16be"]).optional() }, "query"), async (req, res) => {
  if (!req.is("application/octet-stream") || (req.body !== undefined && !Buffer.isBuffer(req.body))) {
    throw Object.assign(new Error("请发送文件原始内容"), { status: 400 });
  }
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req, req.query.directory as string, req.query.path as string);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  let revision: string | undefined;
  try {
    let bytes = req.body ?? Buffer.alloc(0);
    // ACT: 已被自动清理的文件不能被旧页面静默写回复活（revision 与清理记录双重阻断）。
    if (await isFileCleanedByCleanup(path)) {
      throw Object.assign(new Error("文件已被自动清理，未覆盖磁盘内容；请另存副本或重新生成"), { status: 409, code: "ECLEANED" });
    }
    // §P.3（R2）：未完成改名事务的两端（含后代）普通覆盖写必须被拦——写入前消费统一保护判定（不做先写后看），
    // 拒绝并给出事务身份、两端与恢复路径（存量事务返回 ERELOCATING 409）。
    const relocationBlock = await findFileRelocationWriteBlock(path);
    if (relocationBlock) {
      throw Object.assign(new Error(relocationBlock.message), { status: 409, code: "ERELOCATING" });
    }
    if (req.query.expectedRevision) {
      const previous = await readFile(path).catch(error => {
        if (error.code === "ENOENT") throw Object.assign(new Error("文件已被删除或移动，未覆盖磁盘内容"), { status: 409, code: "ESTALE" });
        throw error;
      });
      if (createHash("sha256").update(previous).digest("hex") !== req.query.expectedRevision) {
        throw Object.assign(new Error("文件已被其他编辑器修改，当前修改已保留，请重新载入磁盘版本或另存副本"), { status: 409, code: "ESTALE" });
      }
    }
    if (req.query.encoding && req.query.encoding !== "utf-8") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (req.query.encoding === "utf-8-bom") bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
      else {
        const encoded = Buffer.from(text, "utf16le");
        if (req.query.encoding === "utf-16be") encoded.swap16();
        bytes = Buffer.concat([Buffer.from(req.query.encoding === "utf-16be" ? [0xfe, 0xff] : [0xff, 0xfe]), encoded]);
      }
    }
    const declared = fileKinds[req.get("x-toonflow-file-kind") as keyof typeof fileKinds];
    // T17：声明来源的写入同时记录本次内容的完整身份（size+sha256），供崩溃恢复区分
    // 「覆盖前旧文件仍在」「新内容已原子发布但登记未完」；expectedRevision 校验复用同一摘要。
    const digest = declared || req.query.expectedRevision ? createHash("sha256").update(bytes).digest("hex") : undefined;
    if (declared) {
      // ACT: 先建立持久登记保护（围栏，含写前版本与预期发布内容身份），同一路径锁内写文件并登记；
      // 登记失败保留围栏并传播给调用方。
      const guard = await beginFileRegistrationProtection(
        { path, directory, sourceKind: declared[0], mediaKind: declared[1], refs: [] },
        { expectedContent: { size: bytes.length, sha256: digest! } },
      );
      let written = false;
      try {
        await u.workspaceFile.writeWorkspaceFile(path, bytes, req.query.exclusive === "true");
        written = true;
        if (req.query.expectedRevision) revision = digest;
        await guard.complete();
      } catch (error) {
        // 写入未发布（原子写）时解除围栏；写入已完成但登记失败时保留围栏供恢复重试。
        if (!written) {
          // T15「可能已发布即视为已发布」：writeAtomic 先替换目标再 fsync 父目录，调用抛出不代表没有发布。
          // 用本次预期内容身份核对真实文件：一致则按已发布完成登记（保护围栏与账本保持一致，避免
          // “文件已改变却解除围栏”的裸窗口）；不一致才按未发布解除围栏。原错误照常传播给调用方。
          let published = false;
          try {
            const actual = await readFile(path);
            published = actual.length === bytes.length && createHash("sha256").update(actual).digest("hex") === digest;
          } catch {
            published = false;
          }
          if (published) {
            await guard.complete().catch(registerError => console.warn("写入可能已发布但登记失败，登记保护围栏保留待恢复", registerError));
          } else {
            await guard.abort().catch(() => undefined);
          }
        }
        throw error;
      }
    } else {
      await u.workspaceFile.writeWorkspaceFile(path, bytes, req.query.exclusive === "true");
      if (req.query.expectedRevision) revision = digest;
    }
  }
  finally { release(); }
  res.json(success(revision ? { revision } : undefined));
});
