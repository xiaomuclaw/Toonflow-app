import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { previewCleanup, readCleanupSettings, readCleanupStatus } from "@/utils/cleanup";
import {
  editingReleasesFailureSnapshot, fileProtectionsFailureSnapshot, fileRecordsFailureSnapshot, fileRecordsReadinessSnapshot,
} from "@/utils/fileRecords";

const router = Router();

// ACT: 清理状态 + 归属记录/保护表/释放时间表持久故障标记 + 保护/归属就绪快照（T03 可诊断）。
// 故障未显式核对恢复（clearProtectionsStoreFailure）前不会执行删除；readiness.ok=false 时新生成准入也不得放行。
export default router.get("/", async (req, res) => {
  const preview = await previewCleanup();
  const protectionsFailure = fileProtectionsFailureSnapshot();
  const editingReleasesFailure = editingReleasesFailureSnapshot();
  const recordsFailure = fileRecordsFailureSnapshot();
  res.set("Cache-Control", "no-store");
  res.json(success({
    settings: readCleanupSettings(),
    cleanupStatus: readCleanupStatus(),
    preview: { categories: preview.categories, total: preview.total },
    readiness: fileRecordsReadinessSnapshot(),
    ...(protectionsFailure ? { protectionsFailure } : {}),
    ...(editingReleasesFailure ? { editingReleasesFailure } : {}),
    ...(recordsFailure ? { recordsFailure } : {}),
  }));
});
