import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./hud.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadOperatorToken } from "./api.ts";
import { BrowserNotifications } from "./browserNotifications.ts";
import { applyThemeColor, getTheme } from "./theme.ts";

applyThemeColor(getTheme()); // public/theme-init.js already applied a remembered theme itself

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
void loadOperatorToken();
createRoot(root).render(
  <StrictMode>
    <App />
    <BrowserNotifications />
  </StrictMode>,
);
