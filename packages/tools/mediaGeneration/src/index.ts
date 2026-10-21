import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import {
  audioGenerationSchema, cancelMediaTasksSchema, getMediaTasksSchema, imageGenerationSchema, listMediaModelsSchema,
  pauseMediaTasksSchema, resumeMediaTasksSchema, submitMediaTasksSchema, videoGenerationSchema,
} from "./runtime";
import type { MediaTasksContext } from "./runtime";

const configSchema = z.strictObject({
  allowImage: z.boolean().default(true),
  allowVideo: z.boolean().default(true),
  allowAudio: z.boolean().default(true),
});

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ media, config }) {
    if (!media) return [];
    const permissions = configSchema.parse(config);
    const tasks = media as typeof media & MediaTasksContext;
    const generationTools = ([
      { name: "generateImage", mediaType: "image", enabled: permissions.allowImage, label: "生成图片", parameters: imageGenerationSchema, description: "根据提示词和可选的工作区参考图生成图片。", waitingNote: "该工具同步等待生成完成后返回已保存文件路径。" },
      { name: "generateVideo", mediaType: "video", enabled: permissions.allowVideo, label: "生成视频", parameters: videoGenerationSchema, description: "根据提示词和可选的工作区图片、视频、音频、首尾帧生成视频。按模型能力设置生成模式、时长、分辨率和音频。", waitingNote: "该工具同步等待成片返回（视频可能数十分钟甚至更久），不适合批量或跨天等待，且同步生成没有上游任务 ID、服务进程中断后无法按 ID 续查；批量与长期任务请改用 submitVideoTasks 受理、getVideoTasks 查询，或把已有任务交给 resumeVideoTasks 继续查询。" },
      { name: "generateAudio", mediaType: "audio", enabled: permissions.allowAudio, label: "生成音频", parameters: audioGenerationSchema, description: "根据文本或提示词和可选的工作区参考图片和音频生成音频。按模型能力设置音色、语速、音量、语种、采样率和格式。", waitingNote: "该工具同步等待生成完成后返回已保存文件路径。" },
    ] as const).filter(operation => operation.enabled);
    if (!generationTools.length) return [];
    const listTool: ToolDefinition = {
      name: "listMediaModels",
      label: "查询媒体模型",
      description: "查询已允许生成的媒体模型，返回 providerId、modelId、类型、模式及支持的画幅、时长、分辨率或音色。生成前先查询，不能猜测模型 ID。",
      parameters: z.toJSONSchema(listMediaModelsSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        listMediaModelsSchema.parse(params);
        signal?.throwIfAborted();
        const result = (await media.listModels()).filter(model => generationTools.some(operation => operation.mediaType === model.type));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    };
    const generationDefinitions = generationTools.map<ToolDefinition>(operation => ({
      name: operation.name,
      label: operation.label,
      description: `${operation.description}${operation.waitingNote}providerId 和 modelId 必须来自 listMediaModels。引用素材的 path 及 outputDirectory 均为工作区相对路径；省略输出目录使用默认媒体目录。等待生成完成后返回已保存的文件路径，不返回 Base64。`,
      promptSnippet: "生成媒体前先查询 listMediaModels，复用实际模型和工作区参考素材。",
      parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const result = await media[operation.name](operation.parameters.parse(params), signal);
        const text = result.map(asset => {
          const url = asset.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
          const preview = asset.mediaType === "image" ? `![生成图片](<${url}>)` : `[${asset.mediaType === "audio" ? "播放生成音频" : "查看生成视频"}](<${url}>)`;
          return `${preview}\n工作区文件：${asset.path}`;
        }).join("\n\n");
        return { content: [{ type: "text", text }], details: result };
      },
    }));
    // ACT: 持久任务工具走服务端任务接口；受理后不依赖网页或会话在线，查询/取消随时可用。
    const taskDefinitions: ToolDefinition[] = [
      {
        name: "submitVideoTasks",
        label: "提交生成任务",
        description: "批量受理图片、视频或音频生成任务并立即返回 taskId；服务端先持久化受理记录再返回，生成在后台继续，不依赖网页或会话在线，可跨小时/跨天跟进。异步（submitMedia/queryMedia）与同步供应商都走这条公共受理链，同步供应商在服务端进程内后台执行；同步任务没有上游任务 ID，服务进程中断后无法按 ID 跨重启续查。同一 (工作区, batchKey) 始终复用同一 batchId，追加提交并入同一批次；重传同一 batchKey 与 itemKey 与相同参数返回原 taskId，不重复提交；未受理的项只返回 rejected，不给 taskId；模型未声明的参考类别与 mode 在受理前拒绝，不静默忽略。用 getVideoTasks 查询、pauseVideoTasks/resumeVideoTasks 控制跟进、cancelVideoTasks 取消。",
        promptSnippet: "批量或长时间生成改用 submitVideoTasks 受理，再用 getVideoTasks 查询结果。",
        parameters: z.toJSONSchema(submitMediaTasksSchema, { io: "input", target: "draft-07" }),
        async execute(_id, params, signal) {
          const input = submitMediaTasksSchema.parse(params);
          const submit = tasks.submitVideoTasks;
          if (!submit) throw new Error("当前环境不支持持久媒体任务接口");
          if (input.mediaType === "image" && !permissions.allowImage) throw new Error("当前不允许生成图片");
          if (input.mediaType === "video" && !permissions.allowVideo) throw new Error("当前不允许生成视频");
          if (input.mediaType === "audio" && !permissions.allowAudio) throw new Error("当前不允许生成音频");
          signal?.throwIfAborted();
          const result = await submit(input, signal);
          const accepted = result.items.filter(item => item.status === "accepted").length;
          const existing = result.items.filter(item => item.status === "existing").length;
          const rejected = result.items.filter(item => item.status === "rejected").length;
          const lines = result.items.map(item => `- ${item.itemKey}: ${item.status}${item.taskId ? ` taskId=${item.taskId}` : ""}${item.reason ? ` 原因：${item.reason}` : ""}`);
          const text = `已受理 ${accepted} 项，复用 ${existing} 项，拒绝 ${rejected} 项\nbatchId：${result.batchId}\n${lines.join("\n")}`;
          return { content: [{ type: "text", text }], details: result };
        },
      },
      {
        name: "getVideoTasks",
        label: "查询生成任务",
        description: "按 taskIds（≤200）、batchId 或 batchKey 查询持久任务状态；batchKey 返回同一 (工作区, batchKey) 下的全部任务（跨多次提交）。返回状态、跟进标记（active/blocked/paused）、等待原因、退避时间（retryAt）、等待提醒、输出文件的工作区相对路径与可用性（state=available/cleaned/missing、resolvedPath 为改名后最新定位、cleanedAt、sha256、path 为历史原路径）以及去敏错误，batchId/batchKey 查询支持 cursor/limit 分页。succeeded 表示结果已保存到工作区，但输出可能已被清理（输出 state=cleaned 或顶层 outputState=cleaned 时不要播放/下载，也不要当作上游失败）；unknown 是待核对状态，不会自动重新提交；无上游 ID 的待核对任务在明确放弃核对的豁免期内不再占用在途额度。",
        parameters: z.toJSONSchema(getMediaTasksSchema, { io: "input", target: "draft-07" }),
        async execute(_id, params, signal) {
          const input = getMediaTasksSchema.parse(params);
          const query = tasks.getVideoTasks;
          if (!query) throw new Error("当前环境不支持持久媒体任务接口");
          signal?.throwIfAborted();
          const result = await query(input, signal);
          const counts = Object.entries(result.counts).map(([state, count]) => `${state} ${count}`).join("、") || "无";
          const lines = result.tasks.map(task => {
            // 输出统一字段（契约 v4 §G）：state/resolvedPath/cleanedAt/sha256/path；
            // 展示优先用 resolvedPath（改名后最新定位），path 仅作历史原路径回退。
            const outputs = task.outputs.length
              ? ` 输出：${task.outputs.map(output => {
                const state = output.state ?? "available";
                const latest = output.resolvedPath ?? output.path;
                const history = output.resolvedPath && output.resolvedPath !== output.path ? `（原路径 ${output.path}）` : "";
                return `${state}: ${latest}${history}${output.cleanedAt ? `，清理于 ${output.cleanedAt}` : ""}`;
              }).join("、")}`
              : "";
            const error = task.error ? ` 错误：${task.error}` : "";
            const tracking = task.trackingStatus && task.trackingStatus !== "active" ? ` 跟进：${task.trackingStatus}${task.waitingReason ? `（${task.waitingReason}）` : ""}` : "";
            const retry = task.retryAt ? ` 最早重试：${task.retryAt}` : "";
            const abandoned = task.abandonedAt ? ` 已放弃核对：${task.abandonedAt}${task.abandonRevokedAt ? `（已于 ${task.abandonRevokedAt} 撤销豁免）` : ""}` : "";
            const waiting = task.waitingReminder ? ` 已超过等待提醒阈值（${task.waitingReminderAt}），仅提醒不判失败` : "";
            return `- ${task.taskId} ${task.state} ${task.itemKey}${tracking}${retry}${abandoned}${waiting}${outputs}${error}`;
          });
          const text = `${result.tasks.length} 条任务（${counts}）${result.nextCursor ? `，nextCursor：${result.nextCursor}` : ""}\n${lines.join("\n")}`.trim();
          return { content: [{ type: "text", text }], details: result };
        },
      },
      {
        name: "cancelVideoTasks",
        label: "取消生成任务",
        description: "取消指定 taskIds（≤200）或 batchId 的持久任务：确定未提交上游的直接本地取消；下载中取消只暂停取回并保留恢复能力（用 resumeVideoTasks 继续取回，上游已生成的成片不重新生成）；已提交的持久记录取消意图并尝试上游取消，上游未确认时任务保持原状态可继续查询。待核对（unknown）且没有上游 ID 的任务默认只记录取消意图、不伪造上游取消；只有用户明确知道「放弃核对，上游可能仍在生成」时才传 abandonUnconfirmed=true：保留原键/输入/历史、trackingStatus=paused、解除保守在途额度，且不会声称上游已取消；其他状态会逐项拒绝，普通取消不要默认传 true。之后若 bind/resume 成功核实到原 ID，会记录 abandonRevokedAt 撤销豁免并按实际未终结事实重新计入额度。",
        parameters: z.toJSONSchema(cancelMediaTasksSchema, { io: "input", target: "draft-07" }),
        async execute(_id, params, signal) {
          const input = cancelMediaTasksSchema.parse(params);
          const cancel = tasks.cancelVideoTasks;
          if (!cancel) throw new Error("当前环境不支持持久媒体任务接口");
          signal?.throwIfAborted();
          const result = await cancel(input, signal);
          const lines = result.items.map(item => {
            const requested = item.cancellationRequested ? "已记录取消意图" : "未记录取消意图";
            const upstream = item.upstreamCancellation ? "，上游已确认取消" : "";
            const tracking = item.trackingStatus && item.trackingStatus !== "active" ? `，跟进：${item.trackingStatus}` : "";
            const abandoned = item.abandonedAt ? `，已放弃核对：${item.abandonedAt}` : "";
            return `- ${item.taskId} ${item.state}（${requested}${upstream}${tracking}${abandoned}）${item.reason ? ` ${item.reason}` : ""}`;
          });
          const text = `${result.items.length} 条任务\n${lines.join("\n")}`.trim();
          return { content: [{ type: "text", text }], details: result };
        },
      },
      {
        name: "pauseVideoTasks",
        label: "暂停任务跟进",
        description: "暂停服务器对指定 taskIds（≤200）、batchId 或 batchKey 的跟进（停止查询/下载，主状态不变，上游可能仍在生成）。不会取消任务；取消请用 cancelVideoTasks，恢复用 resumeVideoTasks。尚未提交上游的 preparing/queued 任务没有可暂停的跟进动作：会逐项返回「不适用」，排队启停请使用全局暂停设置或直接取消。正在提交（submitting）且还没有上游 ID 的任务会先记录暂停意图，不会强杀提交。",
        parameters: z.toJSONSchema(pauseMediaTasksSchema, { io: "input", target: "draft-07" }),
        async execute(_id, params, signal) {
          const input = pauseMediaTasksSchema.parse(params);
          const pause = tasks.pauseVideoTasks;
          if (!pause) throw new Error("当前环境不支持持久媒体任务接口");
          signal?.throwIfAborted();
          const result = await pause(input, signal);
          const lines = result.items.map(item => `- ${item.taskId} ${item.status}${item.state ? ` ${item.state}` : ""}${item.reason ? ` 原因：${item.reason}` : ""}`);
          const text = `${result.items.length} 条任务\n${lines.join("\n")}`.trim();
          return { content: [{ type: "text", text }], details: result };
        },
      },
      {
        name: "resumeVideoTasks",
        label: "恢复任务跟进",
        description: "恢复服务器对指定 taskIds（≤200）、batchId 或 batchKey 的跟进并安排查询：只查询/下载已有任务，绝不创建新的上游任务，也不会触发首次生成；尚未提交上游（preparing/queued）或无上游 ID 的待核对任务会被明确拒绝。bindTasks 用于人工补绑：服务端先按当前查询身份对候选 ID 做只读核对（响应 ID/模型/可验证账户），再检查该 ID 未绑定别的本地任务，核对通过才写入并立即恢复查询；核对失败保持原状态并逐项返回原因，不写 ID、不重新生成。同任务同 ID 幂等；已绑定同一 ID 但被自动兼容门挡住（历史记录缺地址或凭据引用等）时，同一条只读核对通过即可解除受阻继续按原 ID 查询。恢复遵守最早重试时间（retryAt），不会提前突破上游 Retry-After。供应商/凭据不兼容时保持 blocked，可再次 resume。",
        parameters: z.toJSONSchema(resumeMediaTasksSchema, { io: "input", target: "draft-07" }),
        async execute(_id, params, signal) {
          const input = resumeMediaTasksSchema.parse(params);
          const resume = tasks.resumeVideoTasks;
          if (!resume) throw new Error("当前环境不支持持久媒体任务接口");
          signal?.throwIfAborted();
          const result = await resume(input, signal);
          const lines = result.items.map(item => `- ${item.taskId} ${item.status}${item.state ? ` ${item.state}` : ""}${item.upstreamId ? ` upstreamId=${item.upstreamId}` : ""}${item.reason ? ` 原因：${item.reason}` : ""}`);
          const text = `${result.items.length} 条任务\n${lines.join("\n")}`.trim();
          return { content: [{ type: "text", text }], details: result };
        },
      },
    ];
    return [listTool, ...generationDefinitions, ...taskDefinitions];
  },
};

export default plugin;
