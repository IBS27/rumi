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

/** The project's published source, as the server last recorded it. */
export type PublishedSource = {
  roomId?: string;
  scanId?: string;
  generation: number;
};

/**
 * Upload a source pair, then publish it in one mutation. With `room`, that
 * mutation also replaces the project's room at its expected revision, so a
 * failed upload leaves the previous room and source intact.
 */
export async function saveWorkspaceFiles(
  projectId: Id<"projects">,
  workspace: Workspace,
  begin: (
    args: FunctionArgs<typeof api.files.begin>,
  ) => Promise<FunctionReturnType<typeof api.files.begin>>,
  publish: (
    args: FunctionArgs<typeof api.files.publish>,
  ) => Promise<FunctionReturnType<typeof api.files.publish>>,
  options: {
    loadScan: (scanId: string) => Promise<Blob | undefined>;
    /** Omit only when the published state is unknown, as during migration. */
    published?: PublishedSource;
    room?: { expectedRevision: number | null };
    /**
     * What a workspace without a scan means: "remove" deliberately saves a
     * JSON-only source; "preserve" refuses to discard a saved scan.
     */
    withoutScan: "remove" | "preserve";
  },
) {
  const { published } = options;
  const keepScan =
    workspace.scanId !== undefined &&
    published?.scanId === workspace.scanId &&
    published.roomId === workspace.room.id;
  const scanBlob =
    workspace.scanId && !keepScan
      ? await options.loadScan(workspace.scanId)
      : undefined;
  if (workspace.scanId && !keepScan && !scanBlob)
    throw new Error(
      "The original scan is unavailable. Re-import its ZIP before saving.",
    );
  const blob = new Blob([JSON.stringify(workspace)], {
    type: "application/json",
  });
  const source = await begin({ projectId, kind: "workspace", size: blob.size });
  await uploadFile(blob, source);
  let scan: FunctionArgs<typeof api.files.publish>["scan"];
  if (keepScan) scan = { action: "keep", scanId: workspace.scanId! };
  else if (workspace.scanId && scanBlob) {
    const authorization = await begin({
      projectId,
      kind: "scan",
      size: scanBlob.size,
    });
    await uploadFile(scanBlob, authorization);
    scan = {
      action: "replace",
      fileId: authorization.fileId,
      scanId: workspace.scanId,
    };
  } else if (options.withoutScan === "remove") scan = { action: "remove" };
  return publish({
    projectId,
    workspaceFileId: source.fileId,
    roomId: workspace.room.id,
    scan,
    expectedGeneration: published?.generation,
    ...(options.room
      ? {
          room: workspace.room,
          expectedRevision: options.room.expectedRevision,
        }
      : {}),
  });
}
