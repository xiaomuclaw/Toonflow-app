import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import {
  clearFileRangeProtection, clearFileRegistrationFence, clearFileRelocationIntentsForPath, clearProtectionsStoreFailure,
  editingReleasesFailureSnapshot, fileProtectionsFailureSnapshot, fileRecordsFailureSnapshot, listFileRelocationIntents,
} from "@/utils/fileRecords";
import { resolveEditingPaths } from "@/utils/fileRecords/editingIdentity";

const router = Router();

// ACT: 保护表/归属表持久故障 / 范围保护 / 未完成改名事务意图的显式恢复入口（互审问题 3；T16/T14/T03/T15 保留同一入口的认证与非空核对原因要求）。
// 契约 §J/§N.1/§O.2 要求“人工核对成功后才解除”，但原实现只有内部函数、没有任何调用方——一旦保护表/归属记录/释放时间表故障、
// 某路径被范围保护、存在无法自动确认的未完成登记围栏或未完成改名事务意图，自动清理与新生成准入会永久暂停且只能改盘上文件恢复。
// 本入口提供受认证保护的显式核对动作：必须携带核对原因，可选 paths（工作区内路径）逐条
// 解除范围保护、清除未完成登记围栏（进程内正在写入的 live guard 拒绝并返回 409）并清除相关改名事务意图；
// 仅清除故障标记、指定范围保护/围栏/意图，不动其他历史保护条目与归属账本。
export default router.post("/", validateFields({
  directory: z.string().min(1).max(4096),
  reason: z.string().min(1).max(1000),
  paths: z.array(z.string().min(1).max(4096)).max(256).optional(),
}, "body"), async (req, res) => {
  const reason = String(req.body.reason).trim();
  if (!reason) throw Object.assign(new Error("显式恢复核对必须提供核对原因"), { status: 400, code: "EINVALID" });
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const paths = Array.isArray(req.body.paths) && req.body.paths.length ? await resolveEditingPaths(directory, req.body.paths) : [];
  let clearedPaths = 0;
  let clearedFences = 0;
  let clearedIntentTransactions = 0;
  let clearedIntentEntries = 0;
  const intentClearNotes: string[] = [];
  for (const path of paths) {
    // §P.2（R1b）：先走改名事务的活动边界判定——事务仍在提交/补偿（Q 运行时或持久参与集合未收敛）时
    // clearFileRelocationIntentsForPath 以 409 忙状态拒绝，且本路径不先清除范围保护/登记围栏，
    // 避免在活动事务上留下部分解除状态；无活动且核对完成后才按同一事实清理。
    const intents = await clearFileRelocationIntentsForPath(path);
    clearedIntentTransactions += intents.transactions;
    clearedIntentEntries += intents.entries;
    if (intents.persistence === "unconfirmed") intentClearNotes.push(`${path}：${intents.note ?? "清除落盘未确认"}`);
    // 回执统计真实清除数（而非请求路径数）：该路径实际清掉了范围保护、登记围栏和/或改名意图才计入。
    const rangeCleared = await clearFileRangeProtection(path);
    const fenceCleared = await clearFileRegistrationFence(path);
    if (fenceCleared) clearedFences += 1;
    if (rangeCleared || fenceCleared || intents.transactions > 0) clearedPaths += 1;
  }
  await clearProtectionsStoreFailure(reason);
  // §P.4：清除落盘未确认（writeAtomic 失败但当前磁盘已无该意图）不得静默按成功处理，也不得宣称保护仍在。
  const warning = intentClearNotes.length
    ? `部分改名事务意图清除落盘未确认（清除可能已发布、重启不再保留该屏障，需核对保护状态与任务账本）：${intentClearNotes.join("；")}`
    : undefined;
  res.set("Cache-Control", "no-store").json(success({
    requestedPaths: paths.length,
    clearedPaths,
    clearedFences,
    clearedIntentTransactions,
    clearedIntentEntries,
    ...(warning ? { warning } : {}),
    protectionsFailure: fileProtectionsFailureSnapshot(),
    editingReleasesFailure: editingReleasesFailureSnapshot(),
    recordsFailure: fileRecordsFailureSnapshot(),
    relocationIntents: await listFileRelocationIntents(),
  }));
});
