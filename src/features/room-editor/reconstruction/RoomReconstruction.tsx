import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, LoaderCircle, RotateCcw } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import {
  validateSceneForRoom,
  type ReconstructionInput,
  type ReconstructedScene,
} from "../../../../shared/reconstruction/contracts";
import { Button, FloatingPanel, Heading, Muted } from "../../../ui";

export function RoomReconstruction({
  input,
  onReady,
}: {
  input: ReconstructionInput;
  onReady: (scene: ReconstructedScene) => void;
}) {
  const start = useAction(api.roomReconstruction.start);
  const retry = useMutation(api.roomReconstruction.retry);
  const [id, setId] = useState<Id<"roomReconstructions"> | null>(null);
  const [error, setError] = useState("");
  const [request, setRequest] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const job = useQuery(api.roomReconstruction.get, id ? { id } : "skip");
  const ready = useEffectEvent(onReady);
  const result = useMemo(() => {
    if (
      job?.stage !== "ready" ||
      !job.sceneJson ||
      input.room.shape !== "polygon"
    )
      return null;
    try {
      return {
        scene: validateSceneForRoom(JSON.parse(job.sceneJson), input.room),
        error: "",
      };
    } catch {
      return {
        scene: null,
        error:
          "The reconstructed room could not be opened. Your original scan is still available.",
      };
    }
  }, [job, input]);
  useEffect(() => {
    let canceled = false;
    void start({ inputJson: JSON.stringify(input) })
      .then((id) => {
        if (!canceled) setId(id);
      })
      .catch(() => {
        if (!canceled)
          setError(
            "Room reconstruction is unavailable. Check your connection and try again. Your scan is still available.",
          );
      });
    return () => {
      canceled = true;
    };
  }, [input, start, request]);
  useEffect(() => {
    if (result?.scene) ready(result.scene);
  }, [result]);
  if (result?.scene) return null;
  const failure =
    error ||
    result?.error ||
    job?.error ||
    (id && job === null
      ? "This reconstruction is no longer available. Import your scan again."
      : "");
  const steps = [
    "Reading room photos",
    "Modeling furniture",
    "Preparing your room",
  ];
  const active =
    job?.stage === "modeling" ? (job.completed === job.total ? 2 : 1) : 0;
  return (
    <FloatingPanel className="left-1/2 top-24 z-30 w-[min(360px,calc(100%-32px))] -translate-x-1/2 p-5">
      <div
        role={failure ? "alert" : "status"}
        aria-live="polite"
        aria-busy={!failure}
      >
        <Heading className="text-lg">
          {failure ? "Reconstruction paused" : "Creating your simulated room"}
        </Heading>
        <Muted className="mt-2 text-sm">
          {failure ||
            "Matching your furniture and finishes to the scan. This may take a few minutes."}
        </Muted>
        {!failure && (
          <ol className="mt-4 grid gap-3 text-sm">
            {steps.map((label, index) => (
              <li
                key={label}
                className={`flex items-center gap-2 ${index > active ? "text-mute" : "text-teal-deep"}`}
              >
                {index < active ? (
                  <Check size={16} />
                ) : index === active ? (
                  <LoaderCircle
                    size={16}
                    className="animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <span className="h-4 w-4 rounded-full border border-current" />
                )}
                {label}
                {index === 1 && job?.stage === "modeling"
                  ? ` · ${job.completed}/${job.total}`
                  : ""}
              </li>
            ))}
          </ol>
        )}
      </div>
      {failure &&
        !result?.error &&
        job !== null &&
        (!job || job.attempt < 3) && (
          <Button
            className="mt-4"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              setError("");
              if (id && job?.stage === "failed")
                void retry({ id })
                  .catch(() =>
                    setError(
                      "Could not retry. Check your connection and try again.",
                    ),
                  )
                  .finally(() => setRetrying(false));
              else {
                setRequest((value) => value + 1);
                setRetrying(false);
              }
            }}
          >
            <RotateCcw /> Try again
          </Button>
        )}
      {!failure && (
        <Muted className="mt-4 text-xs">
          You can explore the scan while we work. The finished room also
          supports Walk inside.
        </Muted>
      )}
    </FloatingPanel>
  );
}
