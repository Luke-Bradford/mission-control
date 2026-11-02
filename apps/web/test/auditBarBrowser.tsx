import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { LegacyAudit as Audit } from "../src/pages/LegacyAudit.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<Audit />);
