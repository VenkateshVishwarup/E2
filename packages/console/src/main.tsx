import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { installAuth } from "./auth.js";

installAuth();

createRoot(document.getElementById("root")!).render(<App />);
