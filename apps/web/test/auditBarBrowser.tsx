import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { Audit } from "../src/pages/Audit.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<Audit />);
