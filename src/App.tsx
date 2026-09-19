import { ChatPanel, ChatUnavailable } from "./features/chat/ChatPanel";
import { RoomWorkspace } from "./features/room-editor/RoomWorkspace";
import { SignInButton, UserButton, useUser } from "@clerk/react";
import { useConvexAuth } from "convex/react";
import { ScanLine } from "lucide-react";
import { PhoneCapture } from "./features/room-import/PhoneCapture";

function SignedInWorkspace() {
  const { user, isLoaded } = useUser();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const pairingEnabled =
    import.meta.env.VITE_CAPTURE_PAIRING_ENABLED === "true";
  if (!isLoaded)
    return <div className="viewer-fallback">Loading your account…</div>;
  return (
    <RoomWorkspace
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
                  <button className="primary">Sign in to chat</button>
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
            <button>Sign in</button>
          </SignInButton>
        )
      }
      phone={
        pairingEnabled
          ? (receive) =>
              !user ? (
                <SignInButton mode="modal">
                  <button>
                    <ScanLine size={16} /> Scan with iPhone
                  </button>
                </SignInButton>
              ) : isAuthenticated ? (
                <PhoneCapture onReceive={receive} />
              ) : (
                <button disabled>
                  {isLoading ? "Connecting…" : "Capture connection unavailable"}
                </button>
              )
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
    <RoomWorkspace chat={(context) => <ChatUnavailable {...context} />} />
  );
}
