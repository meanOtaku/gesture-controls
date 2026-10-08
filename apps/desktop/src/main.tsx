import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { applyTheme, readTheme } from "./shared/theme/theme";
import "./styles.css";
import "./neo-theme.css";

// Before the first render, so the page never flashes the wrong look.
applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <Toaster />
    </TooltipProvider>
  </StrictMode>
);
