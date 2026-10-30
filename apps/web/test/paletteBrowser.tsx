import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { CommandPalette } from "../src/shell/CommandPalette.tsx";
import { openPalette } from "../src/shell/overlays.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<CommandPalette />);
openPalette();
