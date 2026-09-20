import { useCallback, useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { DesignCommand } from "../../../shared/design";
import type { DesignConnection as Connection } from "../room-editor/designConnection";

export function DesignConnection({
  projectId,
  onChange,
}: {
  projectId: Id<"projects">;
  onChange: (connection: Connection | null) => void;
}) {
  const state = useQuery(api.design.get, { projectId });
  const edit = useMutation(api.design.edit);
  const undoMutation = useMutation(api.design.undo);
  const retry = useMutation(api.design.retryAsset);
  const execute = useCallback(
    (commands: DesignCommand[], expectedRevision: number) =>
      edit({ projectId, commands, expectedRevision }),
    [edit, projectId],
  );
  const undo = useCallback(
    (expectedRevision: number) => undoMutation({ projectId, expectedRevision }),
    [undoMutation, projectId],
  );
  const retryAsset = useCallback(
    (productId: string) => retry({ projectId, productId }),
    [retry, projectId],
  );
  useEffect(() => {
    onChange(state ? { projectId, state, execute, undo, retryAsset } : null);
  }, [state, projectId, execute, undo, retryAsset, onChange]);
  useEffect(() => () => onChange(null), [onChange]);
  return null;
}
