import { useState } from "react";
import GooeyNav from "../components/GooeyNav";
import { Brand } from "../components/Shared";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import CrewScene from "../components/CrewScene";
import GpuBoard from "../components/GpuBoard";
import PoolStory from "../components/story/PoolStory";
import { BRAND } from "../config/brand";
import { navigate } from "../lib/router";
import { useSession } from "../auth/context";


/* One request, executing across a pool. */
const EXEC: { title: string; tag: string; icon: IconName }[] = [
  { title: "Prompt", tag: "you → gateway", icon: "chat" },
  { title: "Split across laptops", tag: "layers in a pipeline", icon: "laptop" },
  { title: "Answer streams", tag: "token by token", icon: "bolt" },
  { title: "Receipt on NEAR", tag: "cost + route on the ledger", icon: "file" },
];

export default function Landing() {
  const [menu, setMenu] = useState(false);
  const session = useSession();
  const openChat = () => navigate("/chat");
  // Logged in already → straight to the playground; otherwise World ID first.
  const login = () => (session.me ? navigate("/chat") : session.openLogin("/chat"));
  return (
    <div className="landing">
      <header className="site-header">
        <Brand />
        <GooeyNav
          id="main-navigation"
          className={`nav-pill${menu ? " mobile-nav-open" : ""}`}
          items={[
            { label: "Platform", href: "#platform" },
            { label: "How it works", href: "#how-it-works" },
            { label: "Earn and spend", href: "#the-pool" },
            { label: "Network", href: "/network" },
            { label: "Become a provider", href: "/getting-started" },
          ]}
          theme="dark"
          size="md"
          frame
          particleCount={15}
          spread={56}
          animationTime={600}
          timeVariance={300}
          gooeyness={0.5}
          wobble={0.5}
          hoverEffect
          onChange={() => {
            if (menu) window.setTimeout(() => setMenu(false), 700);
          }}
        />
        <div className="header-actions">
          <button
            className="button button-blue header-cta"
            onClick={openChat}
          >
            Try it now <Icon name="arrow-up" size={15} />
          </button>
          <button
            className="icon-button mobile-menu-button"
            aria-label="Toggle navigation"
            aria-expanded={menu}
            aria-controls="main-navigation"
            onClick={() => setMenu(!menu)}
          >
            <Icon name={menu ? "close" : "menu"} />
          </button>
        </div>
      </header>
      <main>
        <section className="hero-section" id="platform">
          <div className="hero-atmosphere" aria-hidden="true" />
          <GpuBoard />
          <div className="hero-copy">
            <h1>
              Your laptop, idle tonight.
              <br />
              Part of something bigger.
            </h1>
          </div>
          <div className="scene-caption">
            <span className="tiny-cross">+</span>
            <span>
              MANY SMALL GPUS. ONE MODEL.
            </span>
          </div>
          <a
            className="hero-scroll"
            href="#the-pool"
            aria-label="Scroll to meet the pool"
          >
            <span>THERE’S A WHOLE POOL BEHIND THIS.</span>
            <Icon name="arrow" size={15} />
          </a>
          <div className="pointer-hint">
            <span /> MOVE TO EXPLORE
          </div>
        </section>
        <section className="warm-section content-section" id="the-pool">
          <div className="section-intro loop-intro">
            <h2>
              Serve one pool.
              <br />
              Spend in another.
            </h2>
          </div>
          <div id="the-crew" className="landing-crew">
            <CrewScene variant="landing" />
          </div>
          <ol className="exec-boxes" aria-label="How one request executes">
            {EXEC.map((box, i) => (
              <li key={box.title} className="exec-box" style={{ ["--i" as string]: i }}>
                <span className="exec-icon" aria-hidden="true">
                  <Icon name={box.icon} size={22} />
                </span>
                <b>{box.title}</b>
              </li>
            ))}
          </ol>
        </section>
        <section className="story-section" id="how-it-works">
          <div className="section-topline">
            <span className="section-label">
              <span className="tiny-cross">+</span> FROM QUERY TO PAYOUT
            </span>
            <span className="section-index">02 / HOW IT WORKS</span>
          </div>
          <div className="story-intro">
            <h2>
              Three laptops.
              <br />
              One coordinator.
            </h2>
            <p>
              Scroll to watch a query come in, run across the pool, and get
              split among the laptops by the work each one did.
            </p>
          </div>
          <PoolStory />
        </section>
        <section className="conversation-section content-section">
          <div className="section-topline">
            <span className="section-label">
              <span className="tiny-cross">+</span> EVERY CREDIT ON THE RECORD
            </span>
            <span className="section-index">03 / THE LEDGER</span>
          </div>
          <div className="conversation-layout">
            <div>
              <h2>
                A request settles.
                <br />
                The record stays.
              </h2>
              <p>
                Each request writes a receipt: route, cost and split.
                <br />
                The gateway signs it and appends it to a NEAR contract,
                <br className="desktop-break" /> so anyone can check it on
                NearBlocks.
              </p>
              <button
                className="text-link"
                onClick={() => navigate("/ledger")}
              >
                See the ledger <Icon name="arrow" size={17} />
              </button>
            </div>
            <div className="landing-exchange">
              <div>
                <span className="exchange-name">
                  Stage 1 · RTX 4060 <i />
                </span>
                <p>
                  My layers are done.
                  <br />
                  Handing off to the next stage.
                </p>
              </div>
              <div>
                <span className="exchange-name iris-name">
                  Hedy · Gateway <i />
                </span>
                <p>
                  592.2 credits settled.
                  <br />
                  90% to the route by layers.
                </p>
              </div>
              <div>
                <span className="exchange-name quil-name">
                  Pod <i />
                </span>
                <p>Receipt on the ledger #1877.</p>
              </div>
              <span className="exchange-caption">AN ILLUSTRATIVE RECEIPT</span>
            </div>
          </div>
        </section>
      </main>
      <footer className="site-footer" id="footer">
        <div className="footer-top">
          <div>
            <span className="section-label">SOME BIG MODELS START SMALL.</span>
            <h2>
              Lend a laptop.
              <br />Use the whole network.
            </h2>
            <button className="button button-blue" onClick={login}>
              {session.me ? "Open the playground" : "Log in with World ID"}{" "}
              <Icon name="arrow-up" size={17} />
            </button>
          </div>
          <nav aria-label="Footer navigation">
            <span>TAKE A LOOK AROUND</span>
            <a href="#how-it-works">
              How it works <Icon name="arrow-up" size={14} />
            </a>
            <a href="/chat">
              Playground <Icon name="arrow-up" size={14} />
            </a>
            <a href="/network">
              Network <Icon name="arrow-up" size={14} />
            </a>
            <a href="/ledger">
              Ledger <Icon name="arrow-up" size={14} />
            </a>
            <a href="/payouts">
              Payouts <Icon name="arrow-up" size={14} />
            </a>
            <a href={BRAND.repo} target="_blank" rel="noreferrer">
              Source on GitHub <Icon name="arrow-up" size={14} />
            </a>
            <a href="/privacy.html">
              Privacy <Icon name="arrow-up" size={14} />
            </a>
          </nav>
        </div>
        <div className="footer-bottom">
          <Brand />
          <span>Built for NEAR HACKATHON.</span>
          <a className="footer-credit" href="https://commons.wikimedia.org/wiki/File:Connect3D_X1800XT_512_MB_(heatsink_removed).png" target="_blank" rel="noreferrer">
            GPU photo: Trio3D / Wikimedia Commons, CC BY-SA 3.0 (edited)
          </a>
          <a href="#platform">
            Back to the stars <Icon name="arrow-up" size={13} />
          </a>
          <span className="footer-year">2026</span>
        </div>
      </footer>
    </div>
  );
}
