import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadSettings } from "@/lib/settings";
// Roboto Mono (OFL, Google) ships with the app so numbers look the
// same on every machine, installed or not. Latin only keeps the bundle small.
import "@fontsource/roboto-mono/latin-400.css";
import "@fontsource/roboto-mono/latin-500.css";
import "@fontsource/roboto-mono/latin-600.css";
import "@fontsource/roboto-mono/latin-700.css";
import "./styles.css";

// Canvas text (EQ axis labels) can't wait on CSS to fetch the font lazily.
void document.fonts?.load('10px "Roboto Mono"');

// The stores read their saved settings as they are created, so App (and
// with it every store) is imported only once the settings are in.
void loadSettings()
  .then(() => import("./App"))
  .then(({ App }) =>
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
