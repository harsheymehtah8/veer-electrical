import { NavLink } from "react-router-dom";
import { Megaphone, BookUser, FolderTree, Bot, Settings as SettingsIcon } from "lucide-react";

const items = [
  { to: "/", label: "Blast", icon: Megaphone, testid: "nav-broadcast" },
  { to: "/contacts", label: "Contacts", icon: BookUser, testid: "nav-contacts" },
  { to: "/catalog", label: "Catalog", icon: FolderTree, testid: "nav-catalog" },
  { to: "/bot", label: "Bot", icon: Bot, testid: "nav-bot" },
  { to: "/settings", label: "More", icon: SettingsIcon, testid: "nav-more" },
];

export default function BottomNav() {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 backdrop-blur-xl bg-white/95 border-t border-gray-200 shadow-[0_-2px_18px_rgba(0,0,0,0.04)]"
      data-testid="bottom-nav"
    >
      <div className="max-w-2xl mx-auto grid grid-cols-5 h-16">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to === "/"}
            data-testid={it.testid}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 text-[11px] press-fx ${
                isActive ? "text-emerald-600 font-semibold" : "text-gray-500"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <it.icon className={`w-5 h-5 ${isActive ? "stroke-[2.4]" : ""}`} />
                <span>{it.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
      <div className="h-[env(safe-area-inset-bottom,0)]" />
    </nav>
  );
}
