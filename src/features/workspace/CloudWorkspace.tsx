import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  useConvex,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { RoomWorkspace } from "../room-editor/RoomWorkspace";
import { SessionMenu } from "./SessionMenu";
import { SessionTitle } from "./SessionTitle";
import { readSessions, workspaceSchema, type Workspace } from "./sessions";
import { readScan, saveScan, deleteScan } from "../room-editor/capture/storage";
import {
  saveWorkspaceFiles,
  downloadFile,
  type PublishedSource,
} from "./cloudFiles";
import { useClerk } from "@clerk/react";
import { Button, Notice } from "../../ui";

type Props = ComponentProps<typeof RoomWorkspace>;
const published = (project: Doc<"projects">): PublishedSource => ({
  roomId: project.sourceRoomId,
  scanId: project.sourceScanId,
  generation: project.sourceGeneration ?? 0,
});
const routeId = () =>
  location.pathname.match(/^\/projects\/([a-z0-9]{32})\/?$/)?.[1] as
    Id<"projects"> | undefined;

/** Server project list and routes own navigation. Browser storage is only a migration source. */
export function CloudWorkspace(props: Props) {
  const [active, setActive] = useState<Id<"projects"> | undefined>(routeId);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const { signOut } = useClerk();
  const deleteAccount = useMutation(api.accounts.requestDeletion);
  const { results, status, loadMore } = usePaginatedQuery(
    api.projects.list,
    deleting ? "skip" : {},
    { initialNumItems: 50 },
  );
  const create = useMutation(api.projects.create);
  const remove = useMutation(api.projects.remove);
  const rename = useMutation(api.projects.rename);
  const begin = useMutation(api.files.begin);
  const publish = useMutation(api.files.publish);
  const convex = useConvex();
  const migration = useRef(false);
  const draft = useRef<Promise<Id<"projects">> | null>(null);
  const navigation = useRef(0);
  const navigate = useCallback((id?: Id<"projects">) => {
    navigation.current++;
    draft.current = null;
    history.pushState(null, "", id ? `/projects/${id}` : "/");
    setActive(id);
  }, []);
  useEffect(() => {
    const onPop = () => {
      navigation.current++;
      draft.current = null;
      setActive(routeId());
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  // Import each browser session exactly once; retain local copies until every upload succeeds.
  useEffect(() => {
    if (migration.current) return;
    migration.current = true;
    void (async () => {
      const identity = props.identity ?? "local";
      const local = readSessions(localStorage, identity);
      for (const session of local.sessions) {
        if (!session.workspace) continue;
        const marker = `rumi.migrated.${identity}.${session.id}`;
        if (localStorage.getItem(marker)) continue;
        const workspace = session.workspace;
        const projectId =
          (workspace.cloudProjectId as Id<"projects"> | undefined) ??
          (await create({
            title: session.title ?? workspace.room.name,
            room: workspace.room,
            importKey: session.id,
          }));
        // A published account source is authoritative. An older browser copy
        // must never replace it, even when it lacks the scan the account has.
        const project = (
          await convex.query(api.projects.context, { projectId })
        )?.project;
        if (project && !project.workspaceFileId)
          await saveWorkspaceFiles(projectId, workspace, begin, publish, {
            loadScan: (scanId) => readScan(identity, scanId),
            published: published(project),
            withoutScan: "preserve",
          });
        localStorage.setItem(marker, projectId);
      }
    })().catch((cause) => {
      migration.current = false;
      setError(
        cause instanceof Error
          ? `Browser import paused: ${cause.message}`
          : "Browser import paused. Your local rooms are still saved.",
      );
    });
  }, [begin, publish, create, convex, props.identity]);
  const newProject = async () => {
    try {
      navigate(await create({ title: "New project" }));
    } catch (cause) {
      setError(String(cause));
    }
  };
  const deleteProject = async (id: Id<"projects">) => {
    await remove({ projectId: id });
    const identity = props.identity ?? "local";
    const scanId = localStorage.getItem(`rumi.scan-cache.${identity}.${id}`);
    if (scanId) await deleteScan(identity, scanId);
    localStorage.removeItem(`rumi.scan-cache.${identity}.${id}`);
    const local = readSessions(localStorage, identity);
    for (const session of local.sessions) {
      if (
        session.workspace?.cloudProjectId === id ||
        localStorage.getItem(`rumi.migrated.${identity}.${session.id}`) === id
      ) {
        if (session.workspace?.scanId)
          await deleteScan(identity, session.workspace.scanId);
        session.workspace = null;
      }
    }
    localStorage.setItem(`rumi.sessions.v1.${identity}`, JSON.stringify(local));
    if (id === active) navigate();
  };
  if (deleting) return <div role="status">Deleting your account…</div>;
  const brand = (
    <SessionMenu
      cloud
      onDeleteAccount={() => {
        setDeleting(true);
        void deleteAccount({})
          .then(async () => {
            const identity = props.identity ?? "local";
            try {
              for (const key of Object.keys(localStorage))
                if (key.startsWith("rumi.") && key.includes(identity))
                  localStorage.removeItem(key);
            } catch {
              /* Revoked account access does not depend on browser storage. */
            }
            await deleteScan(identity).catch(() => undefined);
            await signOut({ redirectUrl: "/" });
          })
          .catch((cause) => {
            setDeleting(false);
            setError(String(cause));
          });
      }}
      sessions={results.map((project) => ({
        id: project._id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.createdAt,
        workspace: null,
      }))}
      activeId={active ?? ""}
      onNew={() => void newProject()}
      onSelect={(id) => navigate(id as Id<"projects">)}
      onRemove={(id) => {
        void deleteProject(id as Id<"projects">).catch((cause) =>
          setError(String(cause)),
        );
      }}
    />
  );
  const selected = results.find((project) => project._id === active);
  return (
    <>
      {error && (
        <Notice tone="error" className="fixed bottom-4 left-4 z-50">
          {error}
        </Notice>
      )}
      {status === "CanLoadMore" && (
        <Button
          className="fixed bottom-4 left-4 z-40"
          onClick={() => loadMore(50)}
        >
          Load more projects
        </Button>
      )}
      {active ? (
        <ProjectWorkspace
          key={active}
          {...props}
          projectId={active}
          brand={brand}
          title={
            <SessionTitle
              value={selected?.title ?? "Project"}
              fallback="Project"
              onRename={(title) => {
                void rename({
                  projectId: active,
                  title: title || "Project",
                }).catch((cause) => setError(String(cause)));
              }}
            />
          }
          onNavigate={(id) =>
            id ? navigate(id as Id<"projects">) : void newProject()
          }
        />
      ) : (
        <RoomWorkspace
          {...props}
          brand={brand}
          onPersist={(workspace) => {
            if (!workspace) return;
            const started = navigation.current;
            return (async () => {
              draft.current ??= create({
                title: workspace.room.name,
                room: workspace.room,
                importKey: crypto.randomUUID(),
              }).catch((cause) => {
                draft.current = null;
                throw cause;
              });
              const id = await draft.current;
              await saveWorkspaceFiles(id, workspace, begin, publish, {
                loadScan: (scanId) =>
                  readScan(props.identity ?? "local", scanId),
                withoutScan: "remove",
              });
              if (started === navigation.current) navigate(id);
            })().catch((cause) => {
              setError(String(cause));
              throw cause;
            });
          }}
          chat={(context) =>
            props.chat({
              ...context,
              onNavigate: (id) =>
                id ? navigate(id as Id<"projects">) : void newProject(),
            })
          }
        />
      )}
    </>
  );
}

function ProjectWorkspace({
  projectId,
  onNavigate,
  ...props
}: Props & {
  projectId: Id<"projects">;
  onNavigate: (id: string | null) => void;
}) {
  const context = useQuery(api.projects.context, { projectId });
  const ticket = useMutation(api.files.ticket);
  const migrate = useMutation(api.migrations.project);
  const begin = useMutation(api.files.begin);
  const publish = useMutation(api.files.publish);
  const source = useRef<PublishedSource | undefined>(undefined);
  const [loaded, setLoaded] = useState<{ workspace: Workspace | null } | null>(
    null,
  );
  const [error, setError] = useState("");
  const savedOriginal = useRef<Workspace["original"]>(undefined);
  const savedScan = useRef<string | undefined>(undefined);
  const savedObjects = useRef<Workspace["reconstructionObjectIds"]>(undefined);
  const savedRoom = useRef<string | undefined>(undefined);
  const pending = useRef(Promise.resolve());
  const initialContext = useRef(context);
  const hasContext = Boolean(context);
  const captureContext = useEffectEvent(() => context);
  useEffect(() => {
    if (!initialContext.current) initialContext.current = captureContext();
    const initial = initialContext.current;
    if (!initial) return;
    let canceled = false;
    void (async () => {
      await migrate({ projectId });
      let saved: ReturnType<typeof workspaceSchema.parse> | null = null;
      try {
        const authorization = await ticket({ projectId, kind: "workspace" });
        saved = authorization
          ? workspaceSchema.parse(
              JSON.parse(await (await downloadFile(authorization)).text()),
            )
          : null;
      } catch {
        if (!canceled)
          setError(
            "Your layout is available, but the original source could not be loaded. Reload to restore scan photos and original export.",
          );
      }
      const workspace: Workspace | null =
        initial.room?.shape === "polygon"
          ? {
              ...(saved?.room.id === initial.room.id ? saved : {}),
              format: "rumi.room",
              version: 1,
              room: initial.room,
              cloudProjectId: projectId,
            }
          : null;
      if (workspace?.scanId) {
        try {
          localStorage.setItem(
            `rumi.scan-cache.${props.identity ?? "local"}.${projectId}`,
            workspace.scanId,
          );
        } catch {
          /* Cache metadata is optional. */
        }
      }
      if (!canceled) {
        source.current = published(initial.project);
        savedOriginal.current = workspace?.original;
        savedScan.current = workspace?.scanId;
        savedObjects.current = workspace?.reconstructionObjectIds;
        savedRoom.current = workspace?.room.id;
        setLoaded({ workspace });
      }
    })().catch((cause) => {
      if (!canceled) setError(String(cause));
    });
    return () => {
      canceled = true;
    };
  }, [hasContext, projectId, ticket, migrate, props.identity]);
  const loadScan = useCallback(
    async (id: string) => {
      try {
        return await readScan(props.identity ?? "local", id);
      } catch {
        /* Restore the account copy. */
      }
      if (id !== loaded?.workspace?.scanId)
        throw new Error(
          "This new scan could not be cached. Download it and re-import its ZIP before saving.",
        );
      const authorization = await ticket({ projectId, kind: "scan" });
      if (!authorization)
        throw new Error(
          "The original scan was never saved to this account. Import its ZIP to restore it.",
        );
      const blob = await downloadFile(authorization);
      try {
        await saveScan(props.identity ?? "local", id, blob);
      } catch {
        /* Browser caching is optional. */
      }
      return blob;
    },
    [projectId, ticket, props.identity, loaded?.workspace?.scanId],
  );
  if (context === null)
    return (
      <div role="alert">
        This project is no longer available.{" "}
        <Button onClick={() => onNavigate(null)}>New project</Button>
      </div>
    );
  if (!loaded)
    return (
      <div role={error ? "alert" : "status"}>
        {error || "Loading your project…"}
      </div>
    );
  function persist(workspace: Workspace | null) {
    if (!workspace) return;
    // Edits already commit through design.edit. Only newly imported source files need uploading.
    if (
      workspace.original === savedOriginal.current &&
      workspace.scanId === savedScan.current &&
      workspace.reconstructionObjectIds === savedObjects.current &&
      workspace.room.id === savedRoom.current
    )
      return;
    savedOriginal.current = workspace.original;
    savedScan.current = workspace.scanId;
    savedObjects.current = workspace.reconstructionObjectIds;
    savedRoom.current = workspace.room.id;
    pending.current = pending.current
      .catch(() => undefined)
      .then(async () => {
        // Upload first; the room changes only when its source publishes with it.
        const { generation } = await saveWorkspaceFiles(
          projectId,
          workspace,
          begin,
          publish,
          {
            loadScan,
            published: source.current,
            room:
              workspace.room.id !== context?.room?.id
                ? { expectedRevision: context?.room?.revision ?? null }
                : undefined,
            withoutScan: "remove",
          },
        );
        source.current = {
          roomId: workspace.room.id,
          scanId: workspace.scanId,
          generation,
        };
        setError("");
      })
      .catch((cause) => {
        savedOriginal.current = undefined;
        savedRoom.current = undefined;
        setError(
          `Cloud save failed: ${String(cause)}. Keep this tab open and export your room before leaving.`,
        );
        throw cause;
      });
    return pending.current;
  }
  return (
    <>
      {error && (
        <Notice tone="error" className="fixed bottom-4 left-4 z-50">
          {error}
        </Notice>
      )}
      <RoomWorkspace
        {...props}
        projectId={projectId}
        loadScan={loadScan}
        initial={loaded.workspace}
        onPersist={persist}
        chat={(value) => props.chat({ ...value, projectId, onNavigate })}
      />
    </>
  );
}
