// W2：媒体输出可携带最小结果元数据（taskId + writeBackToken），供画布保存快照导出同一份回写清单；
// 旧节点/旧画布没有这两个字段时保持原行为。
export type NodeMediaValue = { url: string; mimeType: string; taskId?: string; writeBackToken?: string };

export type NodeValueMap = {
  STRING: string;
  INT: number;
  FLOAT: number;
  BOOLEAN: boolean;
  IMAGE: NodeMediaValue;
  MASK: NodeMediaValue;
  VIDEO: NodeMediaValue;
  AUDIO: NodeMediaValue;
  FILE: NodeMediaValue;
};

export type NodeOutput = {
  [type in keyof NodeValueMap]: { dataType: type; value: NodeValueMap[type] }
}[keyof NodeValueMap];

export type NodeOutputs = Record<string, NodeOutput | undefined>;
export type NodeInputValue = (NodeOutput | { dataType: string | string[]; value: undefined }) & { source: string; sourceHandle: string };

export function isNodeOutput(output: unknown): output is NodeOutput {
  if (!output || typeof output !== "object" || !("dataType" in output) || !("value" in output)) return false;
  const { dataType, value } = output;
  switch (dataType) {
    case "STRING": return typeof value === "string";
    case "BOOLEAN": return typeof value === "boolean";
    case "INT": return typeof value === "number" && Number.isSafeInteger(value);
    case "FLOAT": return typeof value === "number" && Number.isFinite(value);
    case "IMAGE":
    case "MASK":
    case "VIDEO":
    case "AUDIO":
    case "FILE": {
      const mediaType = dataType === "MASK" ? "image" : dataType.toLowerCase();
      return !!value && typeof value === "object" && "url" in value && typeof value.url === "string" && !!value.url.trim()
        && "mimeType" in value && typeof value.mimeType === "string"
        && (dataType === "FILE" ? /^[^/\s]+\/[^/\s]+$/.test(value.mimeType)
          : value.mimeType.startsWith(`${mediaType}/`) && value.mimeType.length > mediaType.length + 1);
    }
    default: return false;
  }
}
