import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { MainApp } from "./main/MainApp.tsx";
import { AgentProvider } from "./store/context.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AgentProvider>
      <MainApp />
    </AgentProvider>
  </StrictMode>,
);
