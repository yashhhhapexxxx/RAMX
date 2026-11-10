import { useEffect, useRef } from "react";

/* Hero visual: a real GPU board photo, cut out and graded into a black + gold look.
   Source: "Connect3D X1800XT 512 MB (heatsink removed)" by Trio3D, Wikimedia Commons,
   CC BY-SA 3.0 (edited: cropped, background removed, recoloured, markings hidden). Credited in the footer.
   It floats gently and tilts towards the pointer; prefers-reduced-motion keeps it still. */

export default function GpuBoard() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const raf = { id: 0 };
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf.id);
      raf.id = requestAnimationFrame(() => {
        const nx = e.clientX / window.innerWidth - 0.5;
        const ny = e.clientY / window.innerHeight - 0.5;
        el.style.setProperty("--rx", `${(-ny * 10).toFixed(2)}deg`);
        el.style.setProperty("--ry", `${(nx * 10).toFixed(2)}deg`);
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      cancelAnimationFrame(raf.id);
      window.removeEventListener("pointermove", move);
    };
  }, []);

  return (
    <div className="gpu-stage" aria-hidden="true">
      <div className="gpu-board" ref={ref}>
        <div className="gpu-float">
          <img src="/brand/gpu-board.webp" alt="" width={1600} height={819} draggable={false} decoding="async" />
          <span className="gpu-core-glow" />
        </div>
      </div>
    </div>
  );
}
