import { SignInButton, UserButton, useUser } from "@clerk/react";
import { useConvexAuth } from "convex/react";
import { Smartphone } from "lucide-react";
import { RoomWorkspace } from "./features/room-editor/RoomWorkspace";
import { PhoneCapture } from "./features/room-import/PhoneCapture";
import { ScanAction } from "./features/room-setup/StartScreen";
import { Button } from "./ui";

function SignedInWorkspace() {
  const { user, isLoaded } = useUser();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const pairingEnabled =
    import.meta.env.VITE_CAPTURE_PAIRING_ENABLED === "true";
  if (!isLoaded)
    return (
      <div className="grid h-full place-items-center text-mute">
        Loading your account…
      </div>
    );
  return (
    <RoomWorkspace
      key={user?.id ?? "local"}
      identity={user?.id ?? "local"}
      account={
        user ? (
          <UserButton />
        ) : (
          <SignInButton mode="modal">
            <Button>Sign in</Button>
          </SignInButton>
        )
      }
      scan={
        pairingEnabled
          ? (placement, receive) => {
              if (!user)
                return (
                  <SignInButton mode="modal">
                    {placement === "start" ? (
                      <ScanAction
                        onClick={() => undefined}
                        note="Sign in first, then pair your phone."
                      />
                    ) : (
                      <Button>
                        <Smartphone /> Scan with iPhone
                      </Button>
                    )}
                  </SignInButton>
                );
              if (!isAuthenticated)
                return placement === "start" ? (
                  <ScanAction
                    disabled
                    onClick={() => undefined}
                    note={
                      isLoading
                        ? "Connecting…"
                        : "Capture connection unavailable."
                    }
                  />
                ) : (
                  <Button disabled>
                    <Smartphone />
                    {isLoading ? "Connecting…" : "Capture unavailable"}
                  </Button>
                );
              return (
                <PhoneCapture onReceive={receive}>
                  {(open) =>
                    placement === "start" ? (
                      <ScanAction onClick={open} />
                    ) : (
                      <Button onClick={open}>
                        <Smartphone /> Scan with iPhone
                      </Button>
                    )
                  }
                </PhoneCapture>
              );
            }
          : undefined
      }
    />
  );
}

export function App() {
  return import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim() &&
    import.meta.env.VITE_CONVEX_URL?.trim() ? (
    <SignedInWorkspace />
  ) : (
    <RoomWorkspace />
  );
}
