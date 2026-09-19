import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App";
import "./styles.css";
const url = import.meta.env.VITE_CONVEX_URL?.trim();
const client = url ? new ConvexReactClient(url) : null;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {client ? (
      <ConvexProvider client={client}>
        <App connected />
      </ConvexProvider>
    ) : (
      <App connected={false} />
    )}
  </StrictMode>,
);
