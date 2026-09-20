import { SignInButton, UserButton, useUser } from "@clerk/react";
import { useConvexAuth } from "convex/react";
import { Smartphone } from "lucide-react";
import { ChatPanel, ChatUnavailable } from "./features/chat/ChatPanel";
import { SessionShell } from "./features/workspace/SessionShell";
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
    <SessionShell
      key={user?.id ?? "local"}
      identity={user?.id ?? "local"}
      chat={(context) =>
        isAuthenticated && user ? (
          <ChatPanel {...context} identity={user.id} />
        ) : (
          <ChatUnavailable
            {...context}
            connecting={Boolean(user) && isLoading}
            signIn={
              user ? (
                <p>
                  We couldn’t connect your account. Please reload and try again.
                </p>
              ) : (
                <SignInButton mode="modal">
                  <Button variant="primary">Sign in to chat</Button>
                </SignInButton>
              )
            }
          />
        )
      }
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
                  {(open, busy) =>
                    placement === "start" ? (
                      <ScanAction onClick={open} disabled={busy} />
                    ) : (
                      <Button onClick={open} disabled={busy}>
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
    <SessionShell chat={(context) => <ChatUnavailable {...context} />} />
  );
}
