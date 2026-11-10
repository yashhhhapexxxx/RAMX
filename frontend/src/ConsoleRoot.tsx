/* Everything behind "Try it now". Lazy-loaded so the landing never ships the wallet or login code. */
import Chat from "./pages/Chat";
import Network from "./pages/Network";
import Account from "./pages/Account";
import Keys from "./pages/Keys";
import Ledger from "./pages/Ledger";
import Payouts from "./pages/Payouts";
import Swarm from "./pages/Swarm";
import NotFound from "./pages/NotFound";
import GettingStarted from "./pages/GettingStarted";
import ConsoleShell from "./components/ConsoleShell";
import type { Route } from "./lib/router";

function page(route: Route) {
  switch (route.name) {
    case "provider":
      return <GettingStarted query={route.query} />;
    case "chat":
      return <Chat query={route.query} />;
    case "account":
      return <Account query={route.query} />;
    case "keys":
      return <Keys />;
    case "network":
      return <Network />;
    case "ledger":
      return <Ledger query={route.query} />;
    case "payouts":
      return <Payouts />;
    case "swarm":
      return <Swarm />;
    default:
      return <NotFound />;
  }
}

export default function ConsoleRoot({ route }: { route: Route }) {
  // NEAR wallets sign in from the login sheet; claims and top-ups are NEAR transactions shown as commands.
  return (
    <ConsoleShell current={route.name} wallet={null}>
      {page(route)}
    </ConsoleShell>
  );
}
