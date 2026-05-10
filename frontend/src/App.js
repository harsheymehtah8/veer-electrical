import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Toaster } from "sonner";
import Login from "@/pages/Login";
import Broadcaster from "@/pages/Broadcaster";
import Leads from "@/pages/Leads";
import Contacts from "@/pages/Contacts";
import Catalog from "@/pages/Catalog";
import BotMessages from "@/pages/BotMessages";
import Senders from "@/pages/Senders";
import Settings from "@/pages/Settings";
import Simulator from "@/pages/Simulator";
import Queue from "@/pages/Queue";
import AppLayout from "@/components/AppLayout";

const RequireAuth = ({ children }) => {
  const token = localStorage.getItem("ve_token");
  if (!token) return <Navigate to="/login" replace />;
  return children;
};

function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-center" richColors />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <AppLayout>
                <Outlet />
              </AppLayout>
            </RequireAuth>
          }
        >
          <Route path="/" element={<Broadcaster />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/bot" element={<BotMessages />} />
          <Route path="/senders" element={<Senders />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/simulator" element={<Simulator />} />
          <Route path="/queue" element={<Queue />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
