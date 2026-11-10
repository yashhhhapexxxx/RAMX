/* Lazy figure slot: a failed chunk or a broken figure leaves an empty slot of the right shape,
   never a blank page. `ratio` keeps the layout from jumping while the figure loads. */
import { Component, Suspense } from "react";
import type { ReactNode } from "react";

class Boundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function FigureBoundary({ ratio, children }: { ratio: string; children: ReactNode }) {
  const slot = <div className="figure-slot" style={{ aspectRatio: ratio }} aria-hidden="true" />;
  return (
    <Boundary fallback={slot}>
      <Suspense fallback={slot}>{children}</Suspense>
    </Boundary>
  );
}
