import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ClerkProvider, useAuth } from "@clerk/react";
import { App } from "./App";
import "./styles.css";
const url = import.meta.env.VITE_CONVEX_URL?.trim();
const client = url ? new ConvexReactClient(url) : null;
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {client && publishableKey ? (
      <ClerkProvider publishableKey={publishableKey}>
        <ConvexProviderWithClerk client={client} useAuth={useAuth}>
          <App />
        </ConvexProviderWithClerk>
      </ClerkProvider>
    ) : (
      <App />
    )}
  </StrictMode>,
);
