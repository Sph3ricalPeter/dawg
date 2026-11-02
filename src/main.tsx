import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadSettings } from "@/lib/settings";
import { loadViews } from "@/lib/view-memory";
import { loadLibrary } from "@/stores/library-store";
// Manrope (OFL, Google) ships with the app as one variable font, so text
// and numbers look the same on every machine, installed or not. Each script
// subset loads only when text in it appears (unicode-range).
import "@fontsource-variable/manrope/wght.css";
import "./styles.css";

// Canvas text (EQ axis labels) can't wait on CSS to fetch the font lazily.
void document.fonts?.load('500 10px "Manrope Variable"');

// The stores read their saved settings as they are created, so App (and
// with it every store) is imported only once the settings are in.
void Promise.all([loadSettings(), loadViews(), loadLibrary()])
  .then(() => import("./App"))
  .then(({ App }) =>
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
