import BottomNav from "@/components/BottomNav";

export default function AppLayout({ children }) {
  return (
    <div className="min-h-screen bg-[#F0F2F5] pb-24" data-testid="app-shell">
      <main className="max-w-2xl mx-auto px-4 pt-4">{children}</main>
      <BottomNav />
    </div>
  );
}
