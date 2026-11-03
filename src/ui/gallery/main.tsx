import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope/wght.css";
import "../../tokens.css";
import "../ui.css";
import "../../styles.css";
import "./gallery.css";
import { Gallery } from "./Gallery";

// The component gallery: `npm run dev`, then open /gallery.html. Only the
// dev server serves it; `vite build` ships index.html alone.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
