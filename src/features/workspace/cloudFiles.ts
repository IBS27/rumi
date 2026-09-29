import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Workspace } from "./sessions";
import { FILE_CHUNK_BYTES } from "../../../shared/files";

export async function uploadFile(
  blob: Blob,
  authorization: { fileId: string; token: string; url: string },
) {
  for (let index = 0; index * FILE_CHUNK_BYTES < blob.size; index++) {
    const response = await fetch(
      `${authorization.url}?fileId=${authorization.fileId}&index=${index}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorization.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: blob.slice(
          index * FILE_CHUNK_BYTES,
          (index + 1) * FILE_CHUNK_BYTES,
        ),
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!response.ok)
      throw new Error("Your file could not be saved. Retry the upload.");
  }
}
export async function downloadFile(ticket: {
  url: string;
  chunks: number;
  size: number;
}) {
  const parts: Blob[] = [];
  for (let index = 0; index < ticket.chunks; index++) {
    const response = await fetch(`${ticket.url}&index=${index}`, {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(
        "Your saved file could not be loaded. Reload to try again.",
      );
    parts.push(await response.blob());
  }
  const blob = new Blob(parts);
  if (ticket.size && blob.size !== ticket.size)
    throw new Error("Incomplete saved file.");
  return blob;
}

export async function saveWorkspaceFiles(
  projectId: Id<"projects">,
  workspace: Workspace,
  scan: Blob | undefined,
  begin: (
    args: FunctionArgs<typeof api.files.begin>,
  ) => Promise<FunctionReturnType<typeof api.files.begin>>,
  publish: (
    args: FunctionArgs<typeof api.files.publish>,
  ) => Promise<FunctionReturnType<typeof api.files.publish>>,
) {
  if (workspace.scanId && !scan)
    throw new Error(
      "The original scan is unavailable. Re-import its ZIP before saving.",
    );
  const blob = new Blob([JSON.stringify(workspace)], {
    type: "application/json",
  });
  const source = await begin({ projectId, kind: "workspace", size: blob.size });
  await uploadFile(blob, source);
  let scanFileId: Id<"files"> | undefined;
  if (scan) {
    const authorization = await begin({
      projectId,
      kind: "scan",
      size: scan.size,
    });
    await uploadFile(scan, authorization);
    scanFileId = authorization.fileId;
  }
  await publish({
    projectId,
    workspaceFileId: source.fileId,
    scanFileId,
    roomId: workspace.room.id,
  });
}
