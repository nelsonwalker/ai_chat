import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShellLayout } from "./ui/AppShellLayout";
import { ChatRoute } from "./routes/ChatRoute";
import { SettingsRoute } from "./routes/SettingsRoute";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShellLayout />,
    children: [
      { index: true, element: <Navigate to="/chats/1" replace /> }, // simple default; we’ll improve later
      { path: "chats/:id", element: <ChatRoute /> },
      { path: "settings", element: <SettingsRoute /> },
    ],
  },
]);
