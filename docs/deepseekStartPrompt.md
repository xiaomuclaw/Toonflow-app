# 发给 DeepSeek 的启动提示词

请使用 Goal 模式执行 Toonflow 单人服务器二改，并按可用能力调用子 AI并行协助。先完整读取：

1. `E:/Ai/codex3/Toonflow/Toonflow-app-master/AGENTS.md`
2. `E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/deepseekExecutionPlan.md`
3. `E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/serverDeploymentPlan.md`

工作目录：`E:/Ai/codex3/Toonflow/Toonflow-app-master`。
真实服务器账号密码、桌面文本模型 API/Key、两套媒体供应商 API/Key，以及待启用的服务器登录/MCP 凭据，已经按用户授权放在：
`E:/Ai/codex3/Toonflow/toonflowHandoff/deploymentSecrets.json`

直接读取配置，不要让我重复提供；不要把密钥输出到聊天、日志、Git 或 Docker 镜像。不要修改正在使用的桌面安装，也不要影响服务器已有业务。

先建立基线、冻结接口和文件归属，再按任务书分波并行：供应商/任务后端/登录，随后画布与 MCP/清理/部署。共享文件主控集成，不能并行的步骤串行，不为并行而增加复杂度。禁止新增任何测试文件或临时测试程序。

画布保留网页驱动，不做无网页画布；正常后台标签要能操作。已受理视频在关闭网页/Codex 后继续。100 条不是上限；本轮只做 10～20 次受理/查询提交验证，调度暂停避免收费；真实视频首轮总计最多 2 条，图生图最多 2 次，由主控统一计数，不能子 AI各自生成。不得重发 unknown 任务。

五类自动清理独立开关默认关闭：生成文本、图片、视频、缓存预填 2 天，原始资料 30 天，均可手填。先建立来源、占用和版本保护，再实现删除。

持续实施、验证、记录进度，不能只输出计划或把构建通过当完成。缺少域名时先完成回环部署和 SSH 隧道验收，询问域名的同时继续其他工作；不要占用其他站点。最终清楚交付已完成、实际验收证据、未覆盖项、访问/MCP方式及回退方法。所有 Goal 状态遵守当前工具要求，不把尚未完成的公网阶段标为完成。
