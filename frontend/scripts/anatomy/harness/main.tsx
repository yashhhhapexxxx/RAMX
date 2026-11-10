/* Dev-only page for checking the Anatomy figures with the skill's capture scripts:
   /scripts/anatomy/harness/?theme=light&fig=gpu|line */
import { createRoot } from "react-dom/client";
import GpuHero from "../../../src/components/anatomy/GpuHero";
import LayerLine from "../../../src/components/anatomy/LayerLine";

const q = new URLSearchParams(location.search);
const theme = q.get("theme") === "light" ? "light" : "dark";
const fig = q.get("fig") ?? "gpu";
if (theme === "light") document.body.classList.add("light");
createRoot(document.getElementById("root")!).render(<div className="wrap">{fig === "gpu" ? <GpuHero theme={theme} /> : <LayerLine theme={theme} />}</div>);
