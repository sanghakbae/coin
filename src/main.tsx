import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import PwaPrompts from "./pwa";
import "./App.css";
import "./pwa.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <PwaPrompts />
  </StrictMode>,
);
