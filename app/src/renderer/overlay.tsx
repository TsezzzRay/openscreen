import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { OverlayApp } from "./overlay/OverlayApp.tsx";
import { AgentProvider } from "./store/context.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AgentProvider>
      <OverlayApp />
    </AgentProvider>
  </StrictMode>,
);
